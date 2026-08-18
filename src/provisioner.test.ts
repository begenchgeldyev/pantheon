import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Provisioner, USER_TOOL_POLICY } from "./provisioner";
import { Registry } from "./registry";
import { Logger } from "./logger/logger";
import type { CliResult } from "./openclaw-cli";
import { loadConfig } from "./config";

const silent = new Logger({ write: () => {} }, "error");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(opts: { slotIdOverride?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "prov-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const templateDir = path.join(root, "tmpl");
  mkdirSync(stateDir); mkdirSync(templateDir);
  writeFileSync(path.join(templateDir, "AGENTS.md"), "# agents");
  writeFileSync(path.join(templateDir, "USER.md.tmpl"), "Name: {{NAME}} @{{USERNAME}}");
  writeFileSync(path.join(templateDir, "TOOLS.md.tmpl"), "Run {{REMIND_BIN}}/remind-in <duration> …");
  const binDir = path.join(root, "bin");
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ALLOWED_USERNAMES: "begench,amina",
    TELEGRAM_OWNER_USERNAME: "begench", NOTIFY_SECRET: "s",
    OPENCLAW_STATE_DIR: stateDir, PANTHEON_DATA_DIR: root, PANTHEON_BIN_DIR: binDir,
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
    if (args[0] === "config" && args[1] === "get") {
      const slot = /^agents\.list\[(\d+)\]\.id$/.exec(args[2] ?? "");
      if (slot) return ok(JSON.stringify(opts.slotIdOverride ?? agents[Number(slot[1])]?.id ?? null));
      return ok(JSON.stringify(agents));
    }
    return ok("");
  };
  const registry = new Registry(":memory:");
  const prov = new Provisioner({ cli, registry, config, templateDir, logger: silent });
  const seedAgent = (id: string) => { agents = [...agents, { id }]; };
  const failingProv = () => new Provisioner({
    cli: async () => ({ code: 1, stdout: "", stderr: "boom" }), registry, config, templateDir, logger: silent,
  });
  return { prov, registry, calls, stateDir, templateDir, binDir, config, seedAgent, failingProv };
}

/**
 * Fake CLI that awaits a small delay per call and tracks how many calls are
 * in flight at once, for exercising the Provisioner's serialisation chain.
 */
function setupDelayed(opts: { failAgentId?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "prov-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const templateDir = path.join(root, "tmpl");
  mkdirSync(stateDir); mkdirSync(templateDir);
  writeFileSync(path.join(templateDir, "AGENTS.md"), "# agents");
  writeFileSync(path.join(templateDir, "USER.md.tmpl"), "Name: {{NAME}} @{{USERNAME}}");
  writeFileSync(path.join(templateDir, "TOOLS.md.tmpl"), "Run {{REMIND_BIN}}/remind-in <duration> …");
  const binDir = path.join(root, "bin");
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ALLOWED_USERNAMES: "begench,amina",
    TELEGRAM_OWNER_USERNAME: "begench", NOTIFY_SECRET: "s",
    OPENCLAW_STATE_DIR: stateDir, PANTHEON_DATA_DIR: root, PANTHEON_BIN_DIR: binDir,
  });
  const calls: string[][] = [];
  let agents: Array<{ id: string }> = [{ id: "main" }];
  let inFlight = 0;
  let maxInFlight = 0;
  const cli = async (args: string[]): Promise<CliResult> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push(args);
    await new Promise((resolve) => setTimeout(resolve, 8));
    try {
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      if (args[0] === "agents" && args[1] === "list") return ok(JSON.stringify(agents));
      if (args[0] === "agents" && args[1] === "add") {
        const id = args[2]!;
        if (opts.failAgentId && id === opts.failAgentId) return { code: 1, stdout: "", stderr: "boom" };
        const ws = args[args.indexOf("--workspace") + 1]!;
        mkdirSync(ws, { recursive: true });
        writeFileSync(path.join(ws, "BOOTSTRAP.md"), "seeded");
        writeFileSync(path.join(ws, "AGENTS.md"), "default seeded");
        agents = [...agents, { id }];
        return ok("{}");
      }
      if (args[0] === "config" && args[1] === "get") {
        const slot = /^agents\.list\[(\d+)\]\.id$/.exec(args[2] ?? "");
        if (slot) return ok(JSON.stringify(agents[Number(slot[1])]?.id ?? null));
        return ok(JSON.stringify(agents));
      }
      return ok("");
    } finally {
      inFlight--;
    }
  };
  const registry = new Registry(":memory:");
  const prov = new Provisioner({ cli, registry, config, templateDir, logger: silent });
  return { prov, registry, calls, stateDir, binDir, getMaxInFlight: () => maxInFlight };
}

const amina = { tgUserId: 42, username: "amina", firstName: "Amina", chatId: 42 };
const kofi = { tgUserId: 43, username: "kofi", firstName: "Kofi", chatId: 43 };

test("owner maps to main without provisioning", async () => {
  const { prov, calls } = setup();
  const rec = await prov.ensureUser({ tgUserId: 1, username: "begench", firstName: "B", chatId: 1 });
  expect(rec.agentId).toBe("main");
  expect(calls.length).toBe(0);
});

test("new user gets u_<id> agent, template files, policy and allowlist", async () => {
  const { prov, calls, stateDir, binDir } = setup();
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
  expect(calls.some((c) => c[0] === "approvals" && c[1] === "allowlist" && c[2] === "add"
    && c[3] === path.join(binDir, "agents/u_42/remind*") && c.includes("u_42"))).toBe(true);
  // The tool-policy write is index-addressed, so the slot is read back.
  const verify = calls.findIndex((c) => c[0] === "config" && c[1] === "get" && c[2] === "agents.list[1].id");
  expect(verify).toBeGreaterThan(calls.indexOf(set));
});

test("a tool policy landing on the wrong agent aborts provisioning", async () => {
  const { prov, registry, calls } = setup({ slotIdOverride: "main" });
  await expect(prov.ensureUser(amina)).rejects.toThrow(/agents\.list/);
  expect(registry.findByUserId(42)).toBeNull();
  expect(calls.some((c) => c[0] === "approvals")).toBe(false);
});

test("the agent gets its own wrapper dir with its id baked in", async () => {
  const { prov, stateDir, binDir } = setup();
  await prov.ensureUser(amina);
  const wrapperDir = path.join(binDir, "agents", "u_42");
  for (const name of ["remind", "remind-in", "remind-cron", "remind-list", "remind-rm"]) {
    const file = path.join(wrapperDir, name);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o111).toBe(0o111); // executable
  }
  expect(readFileSync(path.join(wrapperDir, "remind-in"), "utf8"))
    .toBe('#!/bin/sh\nexec /home/openclaw/bin/remind-impl/remind-in u_42 "$@"\n');
  // TOOLS.md points the agent at its own wrappers, not at bare names.
  const tools = readFileSync(path.join(stateDir, "workspace-u_42", "TOOLS.md"), "utf8");
  expect(tools).toBe(`Run ${wrapperDir}/remind-in <duration> …`);
});

test("MEMORY.md is preserved, never overwritten by the template", async () => {
  const { prov, stateDir, templateDir } = setup();
  writeFileSync(path.join(templateDir, "MEMORY.md"), "template default - must never overwrite user memory");
  const ws = path.join(stateDir, "workspace-u_42");
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, "MEMORY.md"), "keep me");
  await prov.ensureUser(amina);
  expect(readFileSync(path.join(ws, "MEMORY.md"), "utf8")).toBe("keep me");
});

test("second call is a no-op and returns the registry row", async () => {
  const { prov, calls } = setup();
  await prov.ensureUser(amina);
  const n = calls.length;
  const again = await prov.ensureUser(amina);
  expect(again.agentId).toBe("u_42");
  expect(calls.length).toBe(n);
});

test("a retry skips agents add and rewrites the wrappers", async () => {
  const { prov, calls, stateDir, binDir, seedAgent } = setup();
  // Simulate a crash after `agents add` but before the registry insert, with a
  // half-written (or tampered) wrapper left behind.
  mkdirSync(path.join(stateDir, "workspace-u_42"), { recursive: true });
  mkdirSync(path.join(binDir, "agents", "u_42"), { recursive: true });
  writeFileSync(path.join(binDir, "agents", "u_42", "remind"), "#!/bin/sh\nexec /bin/sh\n");
  seedAgent("u_42");
  await prov.ensureUser(amina);
  expect(calls.filter((c) => c[0] === "agents" && c[1] === "add").length).toBe(0);
  expect(calls.some((c) => c[0] === "config" && c[1] === "set")).toBe(true);
  expect(readFileSync(path.join(binDir, "agents", "u_42", "remind"), "utf8"))
    .toBe('#!/bin/sh\nexec /home/openclaw/bin/remind-impl/remind u_42 "$@"\n');
});

test("CLI failure propagates and nothing is registered", async () => {
  const { registry, failingProv } = setup();
  await expect(failingProv().ensureUser(amina)).rejects.toThrow(/agents list/);
  expect(registry.findByUserId(42)).toBeNull();
});

test("concurrent ensureUser for different users is serialised, not parallel", async () => {
  const { prov, calls, getMaxInFlight } = setupDelayed();
  const [r1, r2] = await Promise.all([prov.ensureUser(amina), prov.ensureUser(kofi)]);
  expect(r1.agentId).toBe("u_42");
  expect(r2.agentId).toBe("u_43");
  expect(getMaxInFlight()).toBe(1);
  const sets = calls.filter((c) => c[0] === "config" && c[1] === "set").map((c) => c[2]);
  expect(sets).toEqual(["agents.list[1].tools", "agents.list[2].tools"]);
});

test("concurrent ensureUser for the same user only provisions once", async () => {
  const { prov, calls } = setupDelayed();
  const [r1, r2] = await Promise.all([prov.ensureUser(amina), prov.ensureUser(amina)]);
  expect(r1.agentId).toBe("u_42");
  expect(r2.agentId).toBe("u_42");
  expect(calls.filter((c) => c[0] === "agents" && c[1] === "add").length).toBe(1);
});

test("a failed provisioning rejects its caller but does not wedge the chain", async () => {
  const { prov, registry } = setupDelayed({ failAgentId: "u_42" });
  const failed = prov.ensureUser(amina).catch((e: unknown) => e);
  const succeeded = prov.ensureUser(kofi);
  const [err, rec] = await Promise.all([failed, succeeded]);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/agents add/);
  expect(rec.agentId).toBe("u_43");
  expect(registry.findByUserId(42)).toBeNull();
});
