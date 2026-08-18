// Provisioner: make sure a Telegram user has an OpenClaw agent.
//
// Owner  -> pre-existing agent "main" (no CLI calls).
// Others -> "u_<tgid>": `openclaw agents add`, template workspace files,
//           per-agent remind wrappers, tool policy, exec allowlist,
//           registry row.
//
// Reminder attribution rests on the exec allowlist: each agent gets its own
// wrapper directory whose scripts hard-code its agent id, and only that
// directory is allowlisted for it. Nothing derived from the agent's
// environment (cwd, env, OpenClaw's exec `workdir`) is trusted.
// Every step is idempotent so a crash mid-way is retried safely on the next
// message. All provisioning is serialised through one promise chain because
// `config get` + `config set agents.list[i]` is a read-modify-write.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config";
import { MAIN_AGENT_ID } from "./constants";
import type { Logger } from "./logger/logger";
import type { CliRunner } from "./openclaw-cli";
import type { Registry, UserRecord } from "./registry";

export type TelegramIdentity = { tgUserId: number; username: string; firstName: string; chatId: number };

export const USER_TOOL_POLICY = {
  fs: { workspaceOnly: true },
  deny: ["google-calendar__*", "group:sessions", "group:web", "group:nodes", "group:ui", "group:automation"],
  exec: { security: "allowlist", ask: "off" },
  elevated: { enabled: false },
} as const;

/** The wrapper scripts an agent may exec, and nothing else. */
export function remindWrapperDir(binDir: string, agentId: string): string {
  return path.join(binDir, "agents", agentId);
}

export function remindAllowlistPattern(binDir: string, agentId: string): string {
  return path.join(remindWrapperDir(binDir, agentId), "remind*");
}

export const REMIND_WRAPPERS = ["remind", "remind-in", "remind-cron", "remind-list", "remind-rm"] as const;

/** Byte-identical to what `bin/install-remind-wrappers` writes. */
export function wrapperScript(implDir: string, name: string, agentId: string): string {
  return `#!/bin/sh\nexec ${path.join(implDir, name)} ${agentId} "$@"\n`;
}

export class ProvisionError extends Error {
  override name = "ProvisionError";
}

export function agentIdFor(tgUserId: number): string {
  return `u_${tgUserId}`;
}

export class Provisioner {
  private readonly cli: CliRunner;
  private readonly registry: Registry;
  private readonly config: Config;
  private readonly templateDir: string;
  private readonly logger: Logger;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: { cli: CliRunner; registry: Registry; config: Config; templateDir: string; logger: Logger }) {
    this.cli = opts.cli;
    this.registry = opts.registry;
    this.config = opts.config;
    this.templateDir = opts.templateDir;
    this.logger = opts.logger;
  }

  async ensureUser(id: TelegramIdentity): Promise<UserRecord> {
    const existing = this.registry.findByUserId(id.tgUserId);
    if (existing) return existing;
    // Serialise: chain onto the previous provisioning, swallow its outcome.
    const run = this.chain.then(() => this.provision(id));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async provision(id: TelegramIdentity): Promise<UserRecord> {
    const again = this.registry.findByUserId(id.tgUserId);
    if (again) return again;

    if (id.username === this.config.ownerUsername) {
      this.logger.info("registering owner", { tgUserId: id.tgUserId, agentId: MAIN_AGENT_ID });
      return this.registry.insert({ tgUserId: id.tgUserId, username: id.username, chatId: id.chatId, agentId: MAIN_AGENT_ID });
    }

    const agentId = agentIdFor(id.tgUserId);
    const workspace = path.join(this.config.openclawStateDir, `workspace-${agentId}`);
    this.logger.info("provisioning agent", { tgUserId: id.tgUserId, agentId });

    const existingAgents = await this.listAgents(agentId);
    if (!existingAgents.includes(agentId)) {
      await this.run(["agents", "add", agentId, "--workspace", workspace, "--non-interactive", "--json"], "agents add", agentId);
    }

    const wrapperDir = remindWrapperDir(this.config.binDir, agentId);
    this.installWrappers(wrapperDir, agentId);
    this.seedWorkspace(workspace, id, wrapperDir);

    const index = (await this.listAgents(agentId)).indexOf(agentId);
    if (index < 0) throw new ProvisionError(`agent ${agentId} missing from agents.list after add`);
    await this.run(["config", "set", `agents.list[${index}].tools`, JSON.stringify(USER_TOOL_POLICY)], "config set tools", agentId);
    await this.verifySlot(index, agentId);
    const allowlistPattern = remindAllowlistPattern(this.config.binDir, agentId);
    await this.run(["approvals", "allowlist", "add", allowlistPattern, "--agent", agentId, "--json"], "approvals allowlist add", agentId);

    const rec = this.registry.insert({ tgUserId: id.tgUserId, username: id.username, chatId: id.chatId, agentId });
    this.logger.info("provisioned agent", { tgUserId: id.tgUserId, agentId });
    return rec;
  }

  /** Agent ids in config order (index == position in agents.list). */
  private async listAgents(agentId?: string): Promise<string[]> {
    const where = agentId ? ` (agent ${agentId})` : "";
    const out = await this.run(["config", "get", "agents.list"], "agents list", agentId);
    let parsed: unknown;
    try { parsed = JSON.parse(out); } catch { throw new ProvisionError(`agents list: invalid JSON from openclaw${where}`); }
    if (!Array.isArray(parsed)) throw new ProvisionError(`agents list: expected an array${where}`);
    return parsed.map((a) => String((a as { id: string }).id));
  }

  /**
   * Re-read the slot we just wrote the tool policy into. `config set` addresses
   * agents by index, so a concurrent edit of agents.list (or a stale read)
   * could land a permissive-by-omission policy on somebody else's agent; refuse
   * to continue if the index no longer holds this agent.
   */
  private async verifySlot(index: number, agentId: string): Promise<void> {
    const out = await this.run(["config", "get", `agents.list[${index}].id`], "config get agent id", agentId);
    const seen = parseScalar(out);
    if (seen !== agentId) {
      throw new ProvisionError(
        `tool policy verification failed for agent ${agentId}: agents.list[${index}].id is ${JSON.stringify(seen)}`,
      );
    }
  }

  /**
   * Write this agent's remind wrappers. Idempotent: the content only depends on
   * the agent id, so re-running simply rewrites the same bytes.
   */
  private installWrappers(wrapperDir: string, agentId: string): void {
    mkdirSync(wrapperDir, { recursive: true });
    for (const name of REMIND_WRAPPERS) {
      writeFileSync(path.join(wrapperDir, name), wrapperScript(this.config.remindImplDir, name, agentId), { mode: 0o755 });
    }
  }

  private seedWorkspace(workspace: string, id: TelegramIdentity, wrapperDir: string): void {
    mkdirSync(workspace, { recursive: true });
    const vars: Record<string, string> = {
      "{{NAME}}": id.firstName || id.username,
      "{{USERNAME}}": id.username,
      "{{REMIND_BIN}}": wrapperDir,
    };
    for (const name of readdirSync(this.templateDir)) {
      const src = path.join(this.templateDir, name);
      if (name.endsWith(".md.tmpl")) {
        let body = readFileSync(src, "utf8");
        for (const [token, value] of Object.entries(vars)) body = body.replaceAll(token, value);
        writeFileSync(path.join(workspace, name.slice(0, -".tmpl".length)), body);
      } else if (name.endsWith(".md") && name !== "MEMORY.md") {
        copyFileSync(src, path.join(workspace, name)); // overwrite OpenClaw's default seed
      }
    }
    const memory = path.join(workspace, "MEMORY.md");
    if (!existsSync(memory)) writeFileSync(memory, "# Memory\n\n## Reminders\n\n## Important Dates\n");
    rmSync(path.join(workspace, "BOOTSTRAP.md"), { force: true }); // no onboarding ritual for user agents
  }

  private async run(args: string[], label: string, agentId?: string): Promise<string> {
    const res = await this.cli(args);
    if (res.code !== 0) {
      this.logger.error("openclaw management command failed", { label, agentId: agentId ?? null, code: res.code, stderr: res.stderr.slice(0, 500) });
      throw new ProvisionError(`${label} failed (exit ${res.code})${agentId ? ` for agent ${agentId}` : ""}`);
    }
    return res.stdout;
  }
}

/** `config get <scalar path>` may print a JSON string or a bare value. */
function parseScalar(out: string): string {
  const trimmed = out.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : String(parsed);
  } catch {
    return trimmed;
  }
}
