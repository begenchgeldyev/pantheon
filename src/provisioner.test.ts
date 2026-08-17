import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Provisioner, USER_TOOL_POLICY } from "./provisioner";
import { Registry } from "./registry";
import { Logger } from "./logger/logger";
import type { CliResult } from "./openclaw-cli";
import { loadConfig } from "./config";

const silent = new Logger({ write: () => {} }, "error");

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "prov-"));
  const stateDir = path.join(root, "state");
  const templateDir = path.join(root, "tmpl");
  mkdirSync(stateDir); mkdirSync(templateDir);
  writeFileSync(path.join(templateDir, "AGENTS.md"), "# agents");
  writeFileSync(path.join(templateDir, "USER.md.tmpl"), "Name: {{NAME}} @{{USERNAME}}");
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ALLOWED_USERNAMES: "begench,amina",
    TELEGRAM_OWNER_USERNAME: "begench", NOTIFY_SECRET: "s",
    OPENCLAW_STATE_DIR: stateDir, PANTHEON_DATA_DIR: root,
  });
  const calls: string[][] = [];
  let agents: Array<{ id: string }> = [{ id: "main" }];
  const cli = async (args: string[]): Promise<CliResult> => {
    calls.push(args);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (args[0] === "agents" && args[1] === "list") return ok(JSON.stringify(agents));
    if (args[0] === "agents" && args[1] === "add") {
      const id = args[2]!; const ws = args[args.indexOf("--workspace") + 1]!;
      mkdirSync(ws, { recursive: true });
      writeFileSync(path.join(ws, "BOOTSTRAP.md"), "seeded");
      writeFileSync(path.join(ws, "AGENTS.md"), "default seeded");
      agents = [...agents, { id }];
      return ok("{}");
    }
    if (args[0] === "config" && args[1] === "get") return ok(JSON.stringify(agents));
    return ok("");
  };
  const registry = new Registry(":memory:");
  const prov = new Provisioner({ cli, registry, config, templateDir, logger: silent });
  const seedAgent = (id: string) => { agents = [...agents, { id }]; };
  const failingProv = () => new Provisioner({
    cli: async () => ({ code: 1, stdout: "", stderr: "boom" }), registry, config, templateDir, logger: silent,
  });
  return { prov, registry, calls, stateDir, config, seedAgent, failingProv };
}

const amina = { tgUserId: 42, username: "amina", firstName: "Amina", chatId: 42 };

test("owner maps to main without provisioning", async () => {
  const { prov, calls } = setup();
  const rec = await prov.ensureUser({ tgUserId: 1, username: "begench", firstName: "B", chatId: 1 });
  expect(rec.agentId).toBe("main");
  expect(calls.length).toBe(0);
});

test("new user gets u_<id> agent, template files, policy and allowlist", async () => {
  const { prov, calls, stateDir } = setup();
  const rec = await prov.ensureUser(amina);
  expect(rec.agentId).toBe("u_42");
  const ws = path.join(stateDir, "workspace-u_42");
  expect(calls.some((c) => c[0] === "agents" && c[1] === "add" && c[2] === "u_42" && c.includes("--non-interactive"))).toBe(true);
  expect(readFileSync(path.join(ws, "AGENTS.md"), "utf8")).toBe("# agents");          // template overwrote seed
  expect(readFileSync(path.join(ws, "USER.md"), "utf8")).toBe("Name: Amina @amina");
  expect(readFileSync(path.join(ws, "MEMORY.md"), "utf8")).toContain("# Memory");
  expect(existsSync(path.join(ws, "BOOTSTRAP.md"))).toBe(false);
  const set = calls.find((c) => c[0] === "config" && c[1] === "set")!;
  expect(set[2]).toBe("agents.list[1].tools");
  expect(JSON.parse(set[3]!)).toEqual(USER_TOOL_POLICY);
  expect(calls.some((c) => c[0] === "approvals" && c[1] === "allowlist" && c[2] === "add" && c[3] === "/home/openclaw/bin/remind*" && c.includes("u_42"))).toBe(true);
});

test("second call is a no-op and returns the registry row", async () => {
  const { prov, calls } = setup();
  await prov.ensureUser(amina);
  const n = calls.length;
  const again = await prov.ensureUser(amina);
  expect(again.agentId).toBe("u_42");
  expect(calls.length).toBe(n);
});

test("agents add is skipped when the agent already exists in OpenClaw", async () => {
  const { prov, calls, stateDir, seedAgent } = setup();
  // Simulate a crash after `agents add` but before the registry insert.
  mkdirSync(path.join(stateDir, "workspace-u_42"), { recursive: true });
  seedAgent("u_42");
  await prov.ensureUser(amina);
  expect(calls.filter((c) => c[0] === "agents" && c[1] === "add").length).toBe(0);
  expect(calls.some((c) => c[0] === "config" && c[1] === "set")).toBe(true);
});

test("CLI failure propagates and nothing is registered", async () => {
  const { registry, failingProv } = setup();
  await expect(failingProv().ensureUser(amina)).rejects.toThrow(/agents list/);
  expect(registry.findByUserId(42)).toBeNull();
});
