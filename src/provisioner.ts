// Provisioner: make sure a Telegram user has an OpenClaw agent.
//
// Owner  -> pre-existing agent "main" (no CLI calls).
// Others -> "u_<tgid>": `openclaw agents add`, template workspace files,
//           per-agent tool policy, exec allowlist, registry row.
// Every step is idempotent so a crash mid-way is retried safely on the next
// message. All provisioning is serialised through one promise chain because
// `config get` + `config set agents.list[i]` is a read-modify-write.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config";
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

export const REMIND_ALLOWLIST_PATTERN = "/home/openclaw/bin/remind*";
export const OWNER_AGENT_ID = "main";

export class ProvisionError extends Error {
  override name = "ProvisionError";
}

export function agentIdFor(tgUserId: number): string {
  return `u_${tgUserId}`;
}

export class Provisioner {
  private cli: CliRunner;
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
      this.logger.info("registering owner", { tgUserId: id.tgUserId, agentId: OWNER_AGENT_ID });
      return this.registry.insert({ tgUserId: id.tgUserId, username: id.username, chatId: id.chatId, agentId: OWNER_AGENT_ID });
    }

    const agentId = agentIdFor(id.tgUserId);
    const workspace = path.join(this.config.openclawStateDir, `workspace-${agentId}`);
    this.logger.info("provisioning agent", { tgUserId: id.tgUserId, agentId });

    const existingAgents = await this.listAgents();
    if (!existingAgents.includes(agentId)) {
      await this.run(["agents", "add", agentId, "--workspace", workspace, "--non-interactive", "--json"], "agents add");
    }

    this.seedWorkspace(workspace, id);

    const index = (await this.listAgents()).indexOf(agentId);
    if (index < 0) throw new ProvisionError(`agent ${agentId} missing from agents.list after add`);
    await this.run(["config", "set", `agents.list[${index}].tools`, JSON.stringify(USER_TOOL_POLICY)], "config set tools");
    await this.run(["approvals", "allowlist", "add", REMIND_ALLOWLIST_PATTERN, "--agent", agentId, "--json"], "approvals allowlist add");

    const rec = this.registry.insert({ tgUserId: id.tgUserId, username: id.username, chatId: id.chatId, agentId });
    this.logger.info("provisioned agent", { tgUserId: id.tgUserId, agentId });
    return rec;
  }

  /** Agent ids in config order (index == position in agents.list). */
  private async listAgents(): Promise<string[]> {
    const out = await this.run(["config", "get", "agents.list"], "agents list");
    let parsed: unknown;
    try { parsed = JSON.parse(out); } catch { throw new ProvisionError("agents list: invalid JSON from openclaw"); }
    if (!Array.isArray(parsed)) throw new ProvisionError("agents list: expected an array");
    return parsed.map((a) => String((a as { id: string }).id));
  }

  private seedWorkspace(workspace: string, id: TelegramIdentity): void {
    mkdirSync(workspace, { recursive: true });
    for (const name of readdirSync(this.templateDir)) {
      const src = path.join(this.templateDir, name);
      if (name === "USER.md.tmpl") {
        const tmpl = readFileSync(src, "utf8");
        const body = tmpl.replaceAll("{{NAME}}", id.firstName || id.username).replaceAll("{{USERNAME}}", id.username);
        writeFileSync(path.join(workspace, "USER.md"), body);
      } else if (name.endsWith(".md")) {
        copyFileSync(src, path.join(workspace, name)); // overwrite OpenClaw's default seed
      }
    }
    const memory = path.join(workspace, "MEMORY.md");
    if (!existsSync(memory)) writeFileSync(memory, "# Memory\n\n## Reminders\n\n## Important Dates\n");
    rmSync(path.join(workspace, "BOOTSTRAP.md"), { force: true }); // no onboarding ritual for user agents
  }

  private async run(args: string[], label: string): Promise<string> {
    const res = await this.cli(args);
    if (res.code !== 0) {
      this.logger.error("openclaw management command failed", { label, code: res.code, stderr: res.stderr.slice(0, 500) });
      throw new ProvisionError(`${label} failed (exit ${res.code})`);
    }
    return res.stdout;
  }
}
