# Pantheon Multi-User Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an env-configured list of Telegram usernames use Pantheon, each with an isolated, auto-provisioned OpenClaw agent, while the owner keeps the existing `main` agent.

**Architecture:** Pantheon gains a SQLite registry (tg user → agent) and a provisioner that shells out to the OpenClaw CLI (`agents add`, `config set`, `approvals allowlist add`) and seeds a versioned workspace template. Reminder scripts derive the agent from their cwd and carry `agentId` to `/notify`, which resolves the chat via the registry. OpenClaw itself stays stock; isolation is per-agent `tools.fs.workspaceOnly` + exec allowlist (verified live on kz).

**Tech Stack:** Bun (TypeScript, `bun:sqlite`, `bun test`), grammY, OpenClaw CLI 2026.7.1-2, bash + jq for helper scripts.

**Spec:** `docs/superpowers/specs/2026-08-17-multi-user-design.md`

## Global Constraints

- All work happens on `kz` in `/opt/pantheon` as user `openclaw`, branch `multi-user`. Commit with `git -c user.name="Begench Geldyev" -c user.email=begenchgeldyev@gmail.com commit …` (the `openclaw` user has no git identity). Never add Claude/session references to commit messages.
- Follow `CLAUDE.md`: Bun APIs only (`bun:sqlite`, `Bun.spawn`, `Bun.file`), `bun test`.
- OpenClaw CLI for Pantheon: `OPENCLAW_BIN=/home/openclaw/.openclaw/bin/openclaw`; state dir `/home/openclaw/.openclaw`.
- Agent id for a Telegram user: `u_<tgid>`; workspace `<stateDir>/workspace-u_<tgid>`; owner's agent stays `main` with workspace `<stateDir>/workspace`.
- Cron job names: `<agentId>--<slug>`. Notify payload: `{"agentId": string, "text": string}`; a payload without `agentId` is treated as `main` (legacy jobs created before this change; user agents cannot craft raw payloads because their exec is allowlisted to `remind*`).
- Per-user-agent tool policy (exact JSON set on `agents.list[<i>].tools`):
  `{"fs":{"workspaceOnly":true},"deny":["google-calendar__*","group:sessions","group:web","group:nodes","group:ui","group:automation"],"exec":{"security":"allowlist","ask":"off"},"elevated":{"enabled":false}}`
  plus exec allowlist pattern `/home/openclaw/bin/remind*` for that agent.
- Removed config: `TELEGRAM_ALLOWED_USER_ID`, `DEFAULT_AGENT`, `OPENCLAW_AGENTS`. New: `TELEGRAM_ALLOWED_USERNAMES`, `TELEGRAM_OWNER_USERNAME`, optional `PANTHEON_DATA_DIR` (default `./data`), optional `OPENCLAW_STATE_DIR` (default `/home/openclaw/.openclaw`).
- The live bot is restarted only in the final deploy task; until then run tests only.

---

## File map

| Path | Responsibility |
| --- | --- |
| `src/config.ts` (modify) | Env parsing incl. username list, owner, data dir, state dir. |
| `src/registry.ts` (new) | SQLite `users` table: lookups by tg id / agent id, upsert, touch. |
| `src/openclaw-cli.ts` (new) | `runOpenClaw(args)` — spawn the CLI, return `{code, stdout, stderr}`. Shared by provisioner. |
| `src/provisioner.ts` (new) | Idempotent create-agent flow (CLI + template files + policy + allowlist). |
| `src/router.ts` (modify) | Resolve agent from registry; drop selection map. |
| `src/telegram.ts` (modify) | Username auth, ensure-user middleware, `/start` `/help` only. |
| `src/notify.ts` (modify) | Resolve `agentId` → chat via registry. |
| `src/tokens.ts`, `src/container/init-containers.ts` (modify) | Register Registry, Provisioner. |
| `src/index.ts` (modify) | Command menu, startup log. |
| `workspace-template/*.md` (new) | Hermes persona files seeded into every user workspace. |
| `bin/remind`, `bin/remind-in`, `bin/remind-cron`, `bin/remind-list`, `bin/remind-rm`, `bin/remind-lib` (new) | Reminder helpers deployed to `/home/openclaw/bin`. |
| `.env.example`, `README.md`, `.gitignore` (modify) | Docs and ignores. |
| `docs/superpowers/plans/…` | This plan. |

---

### Task 0: Commit the pending container fix

**Files:**
- Modify: `src/container/container-binding.ts` (already changed in working tree)

- [ ] **Step 1: Confirm the diff is only the singleton fix**

Run: `cd /opt/pantheon && git diff`
Expected: only `if (!this.resolved) { … this.resolved = true; }` change.

- [ ] **Step 2: Run tests**

Run: `bun test`
Expected: all pass (router/telegram/openclaw tests).

- [ ] **Step 3: Commit**

```bash
git add src/container/container-binding.ts
git -c user.name="Begench Geldyev" -c user.email=begenchgeldyev@gmail.com commit -m "fix(container): cache singleton instances after first resolve"
```

---

### Task 1: Config — usernames, owner, data dir, state dir

**Files:**
- Modify: `src/config.ts`
- Create: `src/config.test.ts`

**Interfaces (Produces):**
```ts
export type Config = {
  botToken: string;
  allowedUsernames: Set<string>;   // lower-case, no '@'
  ownerUsername: string;           // lower-case, member of allowedUsernames
  openclawBin: string;
  openclawStateDir: string;        // e.g. /home/openclaw/.openclaw
  openclawTimeoutMs: number;
  dataDir: string;                 // e.g. /opt/pantheon/data
  logLevel: LoggerSeverity;
  notifyHost: string;
  notifyPort: number;
  notifySecret: string;
};
export function normalizeUsername(raw: string): string; // trim, strip leading '@', lower-case
export function loadConfig(env?: Record<string, string | undefined>): Config;
```

- [ ] **Step 1: Write failing tests**

`src/config.test.ts`:
```ts
import { test, expect } from "bun:test";
import { loadConfig, normalizeUsername } from "./config";

const base = {
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_ALLOWED_USERNAMES: "Begench, @amina ,",
  TELEGRAM_OWNER_USERNAME: "@Begench",
  NOTIFY_SECRET: "s",
};

test("normalizeUsername strips @, trims and lower-cases", () => {
  expect(normalizeUsername("  @Begench ")).toBe("begench");
});

test("parses allowed usernames and owner", () => {
  const c = loadConfig(base);
  expect([...c.allowedUsernames].sort()).toEqual(["amina", "begench"]);
  expect(c.ownerUsername).toBe("begench");
  expect(c.dataDir.endsWith("/data")).toBe(true);
  expect(c.openclawStateDir).toBe("/home/openclaw/.openclaw");
});

test("owner must be in the allowed list", () => {
  expect(() => loadConfig({ ...base, TELEGRAM_OWNER_USERNAME: "ghost" })).toThrow(/owner/i);
});

test("requires at least one allowed username", () => {
  expect(() => loadConfig({ ...base, TELEGRAM_ALLOWED_USERNAMES: " , " })).toThrow(/TELEGRAM_ALLOWED_USERNAMES/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/config.test.ts`
Expected: FAIL (`normalizeUsername` not exported / `loadConfig` ignores env arg).

- [ ] **Step 3: Rewrite `src/config.ts`**

```ts
import path from "node:path";
import type { LoggerSeverity } from "./logger";

export type Config = {
  /** Telegram bot token from BotFather. Secret. */
  botToken: string;
  /** Telegram usernames allowed to talk to the bot (lower-case, no '@'). */
  allowedUsernames: Set<string>;
  /** Username mapped to the pre-existing `main` agent. Must be allowed. */
  ownerUsername: string;
  /** Executable name or path for the OpenClaw CLI. */
  openclawBin: string;
  /** OpenClaw state dir (holds workspace*, agents/, openclaw.json). */
  openclawStateDir: string;
  /** Hard timeout for a single OpenClaw turn, in milliseconds. */
  openclawTimeoutMs: number;
  /** Directory for Pantheon's own data (users.sqlite). */
  dataDir: string;
  logLevel: LoggerSeverity;
  notifyHost: string;
  notifyPort: number;
  notifySecret: string;
};

class ConfigError extends Error {
  override name = "ConfigError";
}

export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`Missing required environment variable: ${name}`);
  return value;
}

function optional(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function parsePositiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`Environment variable ${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

function parseLogLevel(raw: string): LoggerSeverity {
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  throw new ConfigError(`LOG_LEVEL must be one of debug|info|warn|error, got: ${raw}`);
}

export function loadConfig(env: Env = process.env): Config {
  const botToken = required(env, "TELEGRAM_BOT_TOKEN");

  const allowedUsernames = new Set(
    required(env, "TELEGRAM_ALLOWED_USERNAMES")
      .split(",")
      .map(normalizeUsername)
      .filter((u) => u.length > 0),
  );
  if (allowedUsernames.size === 0) {
    throw new ConfigError("TELEGRAM_ALLOWED_USERNAMES must contain at least one username");
  }

  const ownerUsername = normalizeUsername(required(env, "TELEGRAM_OWNER_USERNAME"));
  if (!allowedUsernames.has(ownerUsername)) {
    throw new ConfigError("TELEGRAM_OWNER_USERNAME must be one of TELEGRAM_ALLOWED_USERNAMES");
  }

  const openclawBin = optional(env, "OPENCLAW_BIN", "openclaw");
  const openclawStateDir = optional(env, "OPENCLAW_STATE_DIR", "/home/openclaw/.openclaw");
  const openclawTimeoutMs =
    parsePositiveInt("OPENCLAW_TIMEOUT_SECONDS", optional(env, "OPENCLAW_TIMEOUT_SECONDS", "120")) * 1000;
  const dataDir = path.resolve(optional(env, "PANTHEON_DATA_DIR", "./data"));
  const logLevel = parseLogLevel(optional(env, "LOG_LEVEL", "info"));
  const notifyHost = optional(env, "NOTIFY_HOST", "127.0.0.1");
  const notifyPort = parsePositiveInt("NOTIFY_PORT", optional(env, "NOTIFY_PORT", "8477"));
  const notifySecret = required(env, "NOTIFY_SECRET");

  return {
    botToken, allowedUsernames, ownerUsername, openclawBin, openclawStateDir,
    openclawTimeoutMs, dataDir, logLevel, notifyHost, notifyPort, notifySecret,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/config.test.ts`
Expected: PASS. (`bun test` overall will now fail in `router.test.ts` because `makeConfig` uses removed fields — fixed in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git -c user.name="Begench Geldyev" -c user.email=begenchgeldyev@gmail.com commit -m "feat(config): allow-list by Telegram username, owner and data dir settings"
```

---

### Task 2: Registry (SQLite)

**Files:**
- Create: `src/registry.ts`, `src/registry.test.ts`
- Modify: `.gitignore` (add `data/`)

**Interfaces (Produces):**
```ts
export type UserRecord = {
  tgUserId: number; username: string; chatId: number; agentId: string;
  createdAt: string; lastSeen: string;
};
export class Registry {
  constructor(dbPath: string);              // ":memory:" allowed
  findByUserId(tgUserId: number): UserRecord | null;
  findByAgentId(agentId: string): UserRecord | null;
  insert(u: { tgUserId: number; username: string; chatId: number; agentId: string }): UserRecord;
  touch(tgUserId: number, username: string, chatId: number): void; // updates username/chat/last_seen
  close(): void;
}
```

- [ ] **Step 1: Write failing tests**

`src/registry.test.ts`:
```ts
import { test, expect } from "bun:test";
import { Registry } from "./registry";

test("insert then find by user id and agent id", () => {
  const r = new Registry(":memory:");
  const u = r.insert({ tgUserId: 7, username: "amina", chatId: 7, agentId: "u_7" });
  expect(u.agentId).toBe("u_7");
  expect(r.findByUserId(7)?.username).toBe("amina");
  expect(r.findByAgentId("u_7")?.tgUserId).toBe(7);
  expect(r.findByUserId(8)).toBeNull();
  expect(r.findByAgentId("u_8")).toBeNull();
});

test("touch updates username, chat and last_seen", async () => {
  const r = new Registry(":memory:");
  const before = r.insert({ tgUserId: 7, username: "amina", chatId: 7, agentId: "u_7" });
  await new Promise((res) => setTimeout(res, 5));
  r.touch(7, "amina_new", 70);
  const after = r.findByUserId(7)!;
  expect(after.username).toBe("amina_new");
  expect(after.chatId).toBe(70);
  expect(after.lastSeen >= before.lastSeen).toBe(true);
});

test("agent id is unique", () => {
  const r = new Registry(":memory:");
  r.insert({ tgUserId: 1, username: "a", chatId: 1, agentId: "main" });
  expect(() => r.insert({ tgUserId: 2, username: "b", chatId: 2, agentId: "main" })).toThrow();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/registry.test.ts`
Expected: FAIL — cannot find module `./registry`.

- [ ] **Step 3: Implement `src/registry.ts`**

```ts
// User registry: Telegram user -> OpenClaw agent.
//
// SQLite via bun:sqlite. This is the single source of truth for "which agent
// belongs to which Telegram user" and is used in both directions:
//   inbound  — telegram user id -> agent id (Router)
//   outbound — agent id -> chat id (notify endpoint)

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type UserRecord = {
  tgUserId: number;
  username: string;
  chatId: number;
  agentId: string;
  createdAt: string;
  lastSeen: string;
};

type Row = {
  tg_user_id: number; username: string; chat_id: number; agent_id: string;
  created_at: string; last_seen: string;
};

function toRecord(row: Row): UserRecord {
  return {
    tgUserId: row.tg_user_id, username: row.username, chatId: row.chat_id,
    agentId: row.agent_id, createdAt: row.created_at, lastSeen: row.last_seen,
  };
}

export class Registry {
  private readonly db: Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        tg_user_id INTEGER PRIMARY KEY,
        username   TEXT NOT NULL,
        chat_id    INTEGER NOT NULL,
        agent_id   TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen  TEXT NOT NULL
      );
    `);
  }

  findByUserId(tgUserId: number): UserRecord | null {
    const row = this.db.query<Row, [number]>("SELECT * FROM users WHERE tg_user_id = ?").get(tgUserId);
    return row ? toRecord(row) : null;
  }

  findByAgentId(agentId: string): UserRecord | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM users WHERE agent_id = ?").get(agentId);
    return row ? toRecord(row) : null;
  }

  insert(u: { tgUserId: number; username: string; chatId: number; agentId: string }): UserRecord {
    const now = new Date().toISOString();
    this.db
      .query("INSERT INTO users (tg_user_id, username, chat_id, agent_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
      .run(u.tgUserId, u.username, u.chatId, u.agentId, now, now);
    return { ...u, createdAt: now, lastSeen: now };
  }

  touch(tgUserId: number, username: string, chatId: number): void {
    this.db
      .query("UPDATE users SET username = ?, chat_id = ?, last_seen = ? WHERE tg_user_id = ?")
      .run(username, chatId, new Date().toISOString(), tgUserId);
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Ignore the data dir and commit**

Append to `.gitignore`:
```
# Pantheon runtime data (users.sqlite)
data/
```

```bash
git add src/registry.ts src/registry.test.ts .gitignore
git -c user.name="Begench Geldyev" -c user.email=begenchgeldyev@gmail.com commit -m "feat(registry): sqlite user -> agent registry"
```

---

### Task 3: OpenClaw CLI runner

**Files:**
- Create: `src/openclaw-cli.ts`, `src/openclaw-cli.test.ts`

**Interfaces (Produces):**
```ts
export type CliResult = { code: number; stdout: string; stderr: string };
export type CliRunner = (args: string[]) => Promise<CliResult>;
export function createCliRunner(bin: string, timeoutMs?: number): CliRunner; // args exclude bin
```

- [ ] **Step 1: Write failing test**

`src/openclaw-cli.test.ts`:
```ts
import { test, expect } from "bun:test";
import { createCliRunner } from "./openclaw-cli";

test("runs a binary and captures stdout, stderr and exit code", async () => {
  const run = createCliRunner("/bin/sh");
  const ok = await run(["-c", "echo out; echo err 1>&2; exit 3"]);
  expect(ok.stdout.trim()).toBe("out");
  expect(ok.stderr.trim()).toBe("err");
  expect(ok.code).toBe(3);
});

test("times out", async () => {
  const run = createCliRunner("/bin/sh", 100);
  await expect(run(["-c", "sleep 5"])).rejects.toThrow(/timed out/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/openclaw-cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/openclaw-cli.ts`:
```ts
// Generic OpenClaw CLI runner used for management commands (agents add,
// config set, approvals ...). Argument ARRAY only — never a shell string.

export type CliResult = { code: number; stdout: string; stderr: string };
export type CliRunner = (args: string[]) => Promise<CliResult>;

async function readStream(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

export function createCliRunner(bin: string, timeoutMs = 60_000): CliRunner {
  return async (args) => {
    const proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
    try {
      const [stdout, stderr] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
      const code = await proc.exited;
      if (timedOut) throw new Error(`command timed out after ${timeoutMs}ms: ${bin} ${args[0] ?? ""}`);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/openclaw-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/openclaw-cli.ts src/openclaw-cli.test.ts
git -c user.name="Begench Geldyev" -c user.email=begenchgeldyev@gmail.com commit -m "feat(openclaw-cli): generic CLI runner for management commands"
```

---

### Task 4: Workspace template + reminder scripts

**Files:**
- Create: `workspace-template/AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `HEARTBEAT.md`, `TOOLS.md`, `USER.md.tmpl`
- Create: `bin/remind-lib`, `bin/remind`, `bin/remind-in`, `bin/remind-cron`, `bin/remind-list`, `bin/remind-rm`
- Create: `bin/remind.test.sh`

**Interfaces (Produces):** scripts on PATH inside `/home/openclaw/bin`; `remind-lib` exports `pantheon_agent_id`, `NOTIFY_CMD`.

- [ ] **Step 1: Copy persona files from the live main workspace**

```bash
cd /opt/pantheon && mkdir -p workspace-template bin
cp ~/.openclaw/workspace/AGENTS.md ~/.openclaw/workspace/SOUL.md ~/.openclaw/workspace/IDENTITY.md ~/.openclaw/workspace/HEARTBEAT.md workspace-template/
grep -n -i "begench\|tomsk\|utc+7" workspace-template/*.md   # expected: no matches
```

- [ ] **Step 2: Write `workspace-template/USER.md.tmpl`**

Placeholders `{{NAME}}`, `{{USERNAME}}` are replaced by the provisioner.
```md
# USER.md - About Your Human

_Learn about the person you're helping. Update this as you go._

- **Name:** {{NAME}}
- **Telegram:** @{{USERNAME}}
- **What to call them:** {{NAME}}
- **Pronouns:** _(unknown)_
- **Timezone:** _(unknown — ask on first reminder request and record it here)_
- **Notes:**

## Context

_(What do they care about? What projects are they working on? Build this over time.)_
```

- [ ] **Step 3: Write `workspace-template/TOOLS.md`** (helpers only — no raw `openclaw cron`; this file is later also installed into the `main` workspace)

```md
# TOOLS.md — Hermes

## Scheduling reminders (real ones — delivered to Telegram)

You have a real outbound wire to the user's Telegram chat. When the user asks
for a reminder at a specific time or after a delay, you MUST actually schedule
it with the helpers below (use the `exec` tool). Do not tell the user you
cannot deliver timed messages — you can. Only these helpers are permitted; do
not try to call `openclaw`, `curl` or other commands directly.

### `remind-in <duration> <job-name> <message>` — relative delay
```
remind-in "15 minutes" tea-break "🫖 Tea is ready"
remind-in "2 days"     followup-lena "Check in with Lena on the proposal"
```
Duration: anything GNU `date -d` understands (`10 seconds`, `3 hours`, `1 week`).

### `remind <ISO-8601 timestamp> <job-name> <message>` — absolute time
```
remind 2026-03-18T09:00:00+07:00 anna-birthday "🎂 Anna's birthday today"
```
The timestamp must include a timezone offset. If the user gives a wall-clock
time, use the timezone recorded in USER.md; if none is recorded, ask once and
write it to USER.md.

### `remind-cron "<5-field cron>" <job-name> <message>` — recurring
```
remind-cron "0 9 25 * *" rent-reminder "🏠 Rent is due on the 1st — transfer today."
remind-cron "0 9 18 3 *" anna-birthday-yearly "🎂 Anna's birthday today"
```
Cron expressions are evaluated in UTC — convert from the user's timezone.

### `remind-list` — show this user's scheduled reminders
### `remind-rm <job-name>` — cancel a reminder

### Job naming
Lowercase kebab-case, descriptive and unique: `anna-birthday`, `tax-deadline-2026`.
Duplicate names fail — add a suffix.

### Verify after scheduling
Always run `remind-list` after scheduling and only say "reminder set" when the
job appears. If the helper printed an error, tell the user — do not fake it.

### What the message can contain
Markdown (bold, italic, code, emoji). Keep reminders to one or two sentences.

### Memory
Store important dates and the user's timezone in MEMORY.md / USER.md in this
workspace so you can answer "what's coming up?" without the reminder list.
```

- [ ] **Step 4: Write `bin/remind-lib`** (sourced by the others; not executed directly)

```bash
#!/bin/bash
# Shared helpers for the remind* scripts. Sourced, not executed.

# The agent id is derived from the working directory OpenClaw's exec tool
# uses, which is always the agent's workspace:
#   <stateDir>/workspace        -> main
#   <stateDir>/workspace-<id>   -> <id>
pantheon_agent_id() {
  local base
  base=$(basename "$PWD")
  case "$base" in
    workspace)   echo "main" ;;
    workspace-*) echo "${base#workspace-}" ;;
    *) echo "remind: cannot determine agent from cwd: $PWD" >&2; return 3 ;;
  esac
}

# Command executed by the cron job at fire time. The JSON body (with agentId
# baked in at schedule time) is passed on stdin via --command-input.
NOTIFY_CMD='curl -sf -X POST http://127.0.0.1:8477/notify -H "X-Pantheon-Secret: $PANTHEON_NOTIFY_SECRET" -H "Content-Type: application/json" -d @-'

notify_body() { # $1 agent id, $2 text
  jq -nc --arg a "$1" --arg t "$2" '{agentId:$a,text:$t}'
}
```

- [ ] **Step 5: Write `bin/remind`**

```bash
#!/bin/bash
# Schedule a one-shot reminder at a specific time.
# Usage: remind <ISO-8601 timestamp> <job-name-slug> <message text>
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/remind-lib"
if [ "$#" -lt 3 ]; then
  echo "usage: remind <iso-timestamp> <job-name> <message text...>" >&2
  exit 2
fi
AT="$1"; NAME="$2"; shift 2; MSG="$*"
AGENT=$(pantheon_agent_id)
openclaw cron add "${AGENT}--${NAME}" --agent "$AGENT" --at "$AT" \
  --command "$NOTIFY_CMD" \
  --command-input "$(notify_body "$AGENT" "$MSG")" \
  --delete-after-run --best-effort-deliver
```

- [ ] **Step 6: Write `bin/remind-in`**

```bash
#!/bin/bash
# Schedule a one-shot reminder relative to now.
# Usage: remind-in <duration> <job-name-slug> <message text>
set -euo pipefail
if [ "$#" -lt 3 ]; then
  echo "usage: remind-in <duration> <job-name> <message text...>" >&2
  exit 2
fi
DUR="$1"; NAME="$2"; shift 2; MSG="$*"
AT=$(date -u -d "+${DUR}" +%Y-%m-%dT%H:%M:%SZ)
exec "$(dirname "$(readlink -f "$0")")/remind" "$AT" "$NAME" "$MSG"
```

- [ ] **Step 7: Write `bin/remind-cron`**

```bash
#!/bin/bash
# Schedule a recurring reminder.
# Usage: remind-cron "<5-field cron expr, UTC>" <job-name-slug> <message text>
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/remind-lib"
if [ "$#" -lt 3 ]; then
  echo "usage: remind-cron \"<cron expr>\" <job-name> <message text...>" >&2
  exit 2
fi
EXPR="$1"; NAME="$2"; shift 2; MSG="$*"
AGENT=$(pantheon_agent_id)
openclaw cron add "${AGENT}--${NAME}" --agent "$AGENT" --cron "$EXPR" \
  --command "$NOTIFY_CMD" \
  --command-input "$(notify_body "$AGENT" "$MSG")" \
  --best-effort-deliver
```

- [ ] **Step 8: Write `bin/remind-list`**

```bash
#!/bin/bash
# List this agent's reminders (name, schedule, next run).
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/remind-lib"
AGENT=$(pantheon_agent_id)
openclaw cron list --json | jq -r --arg p "${AGENT}--" '
  .jobs[] | select(.name | startswith($p))
  | "\(.name | ltrimstr($p))\t\(.schedule.kind)\t\(.schedule.at // .schedule.expr // "")\tnext=\(.state.nextRunAtMs // "-")"' \
  | column -t -s $'\t' || true
```

- [ ] **Step 9: Write `bin/remind-rm`**

```bash
#!/bin/bash
# Cancel a reminder by its job name (without the agent prefix).
# Usage: remind-rm <job-name-slug>
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/remind-lib"
if [ "$#" -ne 1 ]; then echo "usage: remind-rm <job-name>" >&2; exit 2; fi
AGENT=$(pantheon_agent_id)
ID=$(openclaw cron list --json | jq -r --arg n "${AGENT}--$1" '.jobs[] | select(.name == $n) | .id' | head -1)
if [ -z "$ID" ]; then echo "no reminder named: $1" >&2; exit 4; fi
openclaw cron rm "$ID"
```

- [ ] **Step 10: Write `bin/remind.test.sh`** (tests the cwd → agent rule and argument validation without touching OpenClaw)

```bash
#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/remind-lib"
fail() { echo "FAIL: $*" >&2; exit 1; }

T=$(mktemp -d)
mkdir -p "$T/workspace" "$T/workspace-u_42" "$T/other"
( cd "$T/workspace"      && [ "$(pantheon_agent_id)" = "main" ] ) || fail "main mapping"
( cd "$T/workspace-u_42" && [ "$(pantheon_agent_id)" = "u_42" ] ) || fail "u_42 mapping"
( cd "$T/other" && pantheon_agent_id 2>/dev/null ) && fail "other should fail" || true
[ "$(notify_body u_42 'hi "there"')" = '{"agentId":"u_42","text":"hi \"there\""}' ] || fail "body"
"$HERE/remind" 2>/dev/null && fail "remind usage" || [ $? -eq 2 ]
"$HERE/remind-in" 2>/dev/null && fail "remind-in usage" || [ $? -eq 2 ]
"$HERE/remind-cron" 2>/dev/null && fail "remind-cron usage" || [ $? -eq 2 ]
"$HERE/remind-rm" 2>/dev/null && fail "remind-rm usage" || [ $? -eq 2 ]
rm -rf "$T"
echo "OK"
```

- [ ] **Step 11: Make executable and run**

Run: `chmod +x bin/remind bin/remind-in bin/remind-cron bin/remind-list bin/remind-rm bin/remind.test.sh && bin/remind.test.sh`
Expected: `OK`.

- [ ] **Step 12: Commit**

```bash
git add workspace-template bin
git -c user.name="Begench Geldyev" -c user.email=begenchgeldyev@gmail.com commit -m "feat: workspace template and per-agent reminder helpers"
```

---

### Task 5: Provisioner

**Files:**
- Create: `src/provisioner.ts`, `src/provisioner.test.ts`

**Interfaces:**
- Consumes: `CliRunner` (Task 3), `Registry` (Task 2), `Config` (Task 1), template dir (Task 4).
- Produces:
```ts
export type TelegramIdentity = { tgUserId: number; username: string; firstName: string; chatId: number };
export class Provisioner {
  constructor(opts: { cli: CliRunner; registry: Registry; config: Config; templateDir: string; logger: Logger });
  /** Returns the existing or newly created record. Serialised: one provisioning at a time. */
  ensureUser(id: TelegramIdentity): Promise<UserRecord>;
}
export const USER_TOOL_POLICY = { fs: { workspaceOnly: true }, deny: [...], exec: {...}, elevated: { enabled: false } };
```

- [ ] **Step 1: Write failing tests**

`src/provisioner.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/provisioner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/provisioner.ts`**

```ts
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
```

- [ ] **Step 4: Run tests**

Run: `bun test src/provisioner.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/provisioner.ts src/provisioner.test.ts
git -c user.name="Begench Geldyev" -c user.email=begenchgeldyev@gmail.com commit -m "feat(provisioner): create isolated OpenClaw agent per Telegram user"
```

---

### Task 6: Router uses the registry

**Files:**
- Modify: `src/router.ts`, `src/router.test.ts`

**Interfaces (Produces):**
```ts
export type RouteRequest = { userId: number; chatId: number; text: string };
export type RouteResult = { agentId: string; reply: string };
export class Router {
  constructor(client: OpenClawClient, registry: Registry, logger: Logger);
  buildSessionKey(userId: number, chatId: number): string;   // unchanged: telegram:<uid>:<chat>
  agentFor(userId: number): string;                          // throws RouterError if unregistered
  route(req: RouteRequest): Promise<RouteResult>;
}
```

- [ ] **Step 1: Rewrite `src/router.test.ts`**

```ts
import { test, expect } from "bun:test";
import { Router, RouterError } from "./router";
import { Registry } from "./registry";
import { Logger } from "./logger/logger";
import type { OpenClawClient, SendMessageInput } from "./types";

const silentLogger = new Logger({ write: () => {} }, "error");

function recordingClient(): { client: OpenClawClient; calls: SendMessageInput[] } {
  const calls: SendMessageInput[] = [];
  return {
    calls,
    client: { async sendMessage(input) { calls.push(input); return `reply from ${input.agentId}`; } },
  };
}

function registryWith(): Registry {
  const r = new Registry(":memory:");
  r.insert({ tgUserId: 1, username: "begench", chatId: 1, agentId: "main" });
  r.insert({ tgUserId: 42, username: "amina", chatId: 42, agentId: "u_42" });
  return r;
}

test("session key is stable per user+chat", () => {
  const router = new Router(recordingClient().client, registryWith(), silentLogger);
  expect(router.buildSessionKey(7, 9)).toBe("telegram:7:9");
});

test("routes to the user's own agent", async () => {
  const { client, calls } = recordingClient();
  const router = new Router(client, registryWith(), silentLogger);
  const result = await router.route({ userId: 42, chatId: 42, text: "hi" });
  expect(result).toEqual({ agentId: "u_42", reply: "reply from u_42" });
  expect(calls[0]).toEqual({ agentId: "u_42", message: "hi", sessionKey: "telegram:42:42" });
  expect(router.agentFor(1)).toBe("main");
});

test("unregistered user is rejected", async () => {
  const router = new Router(recordingClient().client, registryWith(), silentLogger);
  await expect(router.route({ userId: 99, chatId: 99, text: "hi" })).rejects.toBeInstanceOf(RouterError);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/router.test.ts`
Expected: FAIL (constructor signature / `RouterError` missing).

- [ ] **Step 3: Rewrite `src/router.ts`**

```ts
// Message routing: which agent, which session, then delegate to OpenClawClient.
// The agent is whatever the registry says for this Telegram user; there is no
// per-chat selection any more (one Hermes per user).

import type { Logger } from "./logger/logger";
import type { Registry } from "./registry";
import type { OpenClawClient } from "./types";

export type RouteRequest = { userId: number; chatId: number; text: string };
export type RouteResult = { agentId: string; reply: string };

export class RouterError extends Error {
  override name = "RouterError";
}

export class Router {
  constructor(
    private readonly client: OpenClawClient,
    private readonly registry: Registry,
    private readonly logger: Logger,
  ) {}

  /** Stable per-conversation key; OpenClaw scopes it to --agent. */
  buildSessionKey(userId: number, chatId: number): string {
    return `telegram:${userId}:${chatId}`;
  }

  agentFor(userId: number): string {
    const rec = this.registry.findByUserId(userId);
    if (!rec) throw new RouterError(`no agent registered for user ${userId}`);
    return rec.agentId;
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    const agentId = this.agentFor(req.userId);
    const sessionKey = this.buildSessionKey(req.userId, req.chatId);
    this.logger.debug("router dispatch", { agentId, sessionKey });
    const reply = await this.client.sendMessage({ agentId, message: req.text, sessionKey });
    return { agentId, reply };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/router.test.ts
git -c user.name="Begench Geldyev" -c user.email=begenchgeldyev@gmail.com commit -m "feat(router): resolve agent from user registry"
```

---

### Task 7: Notify resolves agentId → chat

**Files:**
- Modify: `src/notify.ts`
- Create: `src/notify.test.ts`

**Interfaces (Produces):**
```ts
export function resolveNotifyTarget(body: unknown, registry: Registry):
  | { ok: true; chatId: number; agentId: string; text: string }
  | { ok: false; status: 400 | 404; reason: string };
export function createNotifyServer(config: Config, bot: Bot, registry: Registry, logger: Logger): ReturnType<typeof Bun.serve>;
```

- [ ] **Step 1: Write failing tests**

`src/notify.test.ts`:
```ts
import { test, expect } from "bun:test";
import { resolveNotifyTarget } from "./notify";
import { Registry } from "./registry";

function reg() {
  const r = new Registry(":memory:");
  r.insert({ tgUserId: 1, username: "begench", chatId: 1, agentId: "main" });
  r.insert({ tgUserId: 42, username: "amina", chatId: 42, agentId: "u_42" });
  return r;
}

test("resolves agentId to the user's chat", () => {
  const r = resolveNotifyTarget({ agentId: "u_42", text: "hi" }, reg());
  expect(r).toEqual({ ok: true, chatId: 42, agentId: "u_42", text: "hi" });
});

test("missing agentId falls back to main (legacy jobs)", () => {
  const r = resolveNotifyTarget({ text: "old job" }, reg());
  expect(r).toEqual({ ok: true, chatId: 1, agentId: "main", text: "old job" });
});

test("unknown agent -> 404, missing text -> 400", () => {
  expect(resolveNotifyTarget({ agentId: "u_999", text: "x" }, reg())).toMatchObject({ ok: false, status: 404 });
  expect(resolveNotifyTarget({ agentId: "u_42", text: "  " }, reg())).toMatchObject({ ok: false, status: 400 });
  expect(resolveNotifyTarget(null, reg())).toMatchObject({ ok: false, status: 400 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/notify.test.ts`
Expected: FAIL — `resolveNotifyTarget` not exported.

- [ ] **Step 3: Rewrite `src/notify.ts`**

```ts
// Internal notify endpoint (loopback only). Lets scheduled jobs push messages
// to Telegram. Body: {"agentId": "u_42", "text": "..."}; the agent id is
// resolved to the owning user's chat through the registry. A body without
// agentId is treated as "main" for jobs created before multi-user support.

import type { Bot } from "grammy";
import type { Config } from "./config";
import type { Logger } from "./logger/logger";
import type { Registry } from "./registry";
import { markdownToTelegram, splitMessage } from "./telegram";

const LEGACY_AGENT = "main";

export function resolveNotifyTarget(body: unknown, registry: Registry):
  | { ok: true; chatId: number; agentId: string; text: string }
  | { ok: false; status: 400 | 404; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, status: 400, reason: "bad json" };
  const b = body as { agentId?: unknown; text?: unknown };
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) return { ok: false, status: 400, reason: "text required" };
  const agentId = typeof b.agentId === "string" && b.agentId ? b.agentId : LEGACY_AGENT;
  const user = registry.findByAgentId(agentId);
  if (!user) return { ok: false, status: 404, reason: `unknown agent: ${agentId}` };
  return { ok: true, chatId: user.chatId, agentId, text };
}

export function createNotifyServer(config: Config, bot: Bot, registry: Registry, logger: Logger) {
  const send = async (chatId: number, source: string): Promise<void> => {
    for (const chunk of splitMessage(source)) {
      const formatted = markdownToTelegram(chunk);
      try {
        await bot.api.sendMessage(chatId, formatted, { parse_mode: "MarkdownV2" });
      } catch (err) {
        logger.warn("notify markdown send failed, retrying as plain text", {
          error: err instanceof Error ? err.message : String(err),
          sample: formatted.slice(0, 120),
        });
        await bot.api.sendMessage(chatId, chunk);
      }
    }
  };

  return Bun.serve({
    hostname: config.notifyHost,
    port: config.notifyPort,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/notify") return new Response("not found", { status: 404 });
      if (req.headers.get("x-pantheon-secret") !== config.notifySecret) {
        logger.warn("notify unauthorized", { path: url.pathname });
        return new Response("unauthorized", { status: 401 });
      }
      let body: unknown;
      try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

      const target = resolveNotifyTarget(body, registry);
      if (!target.ok) {
        logger.warn("notify rejected", { status: target.status, reason: target.reason });
        return new Response(target.reason, { status: target.status });
      }
      try {
        await send(target.chatId, target.text);
        logger.info("notify delivered", { agentId: target.agentId, chatId: target.chatId, chars: target.text.length });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      } catch (err) {
        logger.error("notify send failed", { agentId: target.agentId, error: err instanceof Error ? err.message : String(err) });
        return new Response("send failed", { status: 502 });
      }
    },
  });
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/notify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/notify.ts src/notify.test.ts
git -c user.name="Begench Geldyev" -c user.email=begenchgeldyev@gmail.com commit -m "feat(notify): route reminders by agentId through the registry"
```

---

### Task 8: Telegram — username auth, ensure-user, simplified commands

**Files:**
- Modify: `src/telegram.ts`
- Modify: `src/telegram.test.ts` (add auth helper test)

**Interfaces (Produces):**
```ts
export function isAllowed(username: string | undefined, allowed: Set<string>): boolean;
export function createBot(config: Config, router: Router, provisioner: Provisioner, registry: Registry, logger: Logger): Bot;
```

- [ ] **Step 1: Add failing test to `src/telegram.test.ts`**

```ts
import { isAllowed } from "./telegram";

test("isAllowed matches case-insensitively and rejects missing usernames", () => {
  const allowed = new Set(["begench", "amina"]);
  expect(isAllowed("Begench", allowed)).toBe(true);
  expect(isAllowed("@amina", allowed)).toBe(true);
  expect(isAllowed("ghost", allowed)).toBe(false);
  expect(isAllowed(undefined, allowed)).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/telegram.test.ts`
Expected: FAIL — `isAllowed` not exported.

- [ ] **Step 3: Edit `src/telegram.ts`**

Replace the imports, `HELP`, `createBot` and `handleTurn` (keep `markdownToTelegram`, `splitMessage`, `sendReply`, `withTyping` unchanged):

```ts
import { Bot, type Context } from "grammy";
import telegramifyMarkdown from "telegramify-markdown";
import { normalizeUsername, type Config } from "./config";
import type { Logger } from "./logger/logger";
import type { Provisioner } from "./provisioner";
import type { Registry } from "./registry";
import type { Router } from "./router";

// ... TELEGRAM_MAX, USER_ERROR, markdownToTelegram, splitMessage, sendReply, withTyping unchanged ...

export function isAllowed(username: string | undefined, allowed: Set<string>): boolean {
  if (!username) return false;
  return allowed.has(normalizeUsername(username));
}

const HELP = [
  "Pantheon — your personal Hermes, a Telegram gateway to OpenClaw.",
  "",
  "Just write to me: dates to remember, reminders to schedule, questions about what's coming up.",
  "",
  "Commands:",
  "/start — check the connection",
  "/help — show this help",
].join("\n");

export function createBot(
  config: Config,
  router: Router,
  provisioner: Provisioner,
  registry: Registry,
  logger: Logger,
): Bot {
  const bot = new Bot(config.botToken);

  // --- Authentication: allow-listed Telegram usernames only. ---
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from || from.is_bot || !isAllowed(from.username, config.allowedUsernames)) {
      logger.warn("rejected unauthorized message", { fromId: from?.id ?? null, username: from?.username ?? null });
      return; // ignore silently
    }
    if (ctx.chat?.type !== "private") return; // no group chats: one user, one agent
    await next();
  });

  // --- Ensure the user has an agent (provisions on first contact). ---
  bot.use(async (ctx, next) => {
    const from = ctx.from!;
    const username = normalizeUsername(from.username!);
    const chatId = ctx.chat!.id;
    try {
      const known = registry.findByUserId(from.id);
      if (known) {
        registry.touch(from.id, username, chatId);
      } else {
        await withTyping(ctx, () =>
          provisioner.ensureUser({ tgUserId: from.id, username, firstName: from.first_name, chatId }),
        );
        await ctx.reply("Hi, I'm Hermes — your own personal assistant for dates and reminders. Tell me what to remember or when to remind you.");
      }
    } catch (err) {
      logger.error("provisioning failed", { userId: from.id, error: err instanceof Error ? err.message : String(err) });
      await ctx.reply(USER_ERROR);
      return;
    }
    await next();
  });

  bot.command("start", (ctx) =>
    ctx.reply(`Pantheon is connected and ready.\nYour agent: ${router.agentFor(ctx.from!.id)}\nSend /help for commands.`),
  );
  bot.command("help", (ctx) => ctx.reply(HELP));

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return ctx.reply("Unknown command. Send /help for the list.");
    await handleTurn(ctx, router, logger, text);
  });

  bot.catch((err) => {
    logger.error("bot handler error", { error: err.error instanceof Error ? err.error.message : String(err.error) });
    err.ctx.reply(USER_ERROR).catch(() => {});
  });

  return bot;
}

async function handleTurn(ctx: Context, router: Router, logger: Logger, text: string): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId === undefined || userId === undefined) return;
  const started = Date.now();
  logger.info("openclaw request started", { userId, chatId });
  try {
    const result = await withTyping(ctx, () => router.route({ userId, chatId, text }));
    logger.info("openclaw response completed", { agentId: result.agentId, chatId, durationMs: Date.now() - started });
    await sendReply(ctx, result.reply, logger);
  } catch (err) {
    logger.error("openclaw request failed", { userId, chatId, durationMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
    await ctx.reply(USER_ERROR);
  }
}
```

Delete `AGENT_ID_RE`, `agentsList`, the `/agents`, `/agent` and per-agent command handlers.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/telegram.test.ts && bunx tsc --noEmit`
Expected: telegram tests PASS; tsc reports errors only in `src/tokens.ts` / `src/container/init-containers.ts` / `src/index.ts` (fixed in Task 9).

- [ ] **Step 5: Commit**

```bash
git add src/telegram.ts src/telegram.test.ts
git -c user.name="Begench Geldyev" -c user.email=begenchgeldyev@gmail.com commit -m "feat(telegram): username allow-list and per-user agent provisioning"
```

---

### Task 9: Wiring — tokens, container, entrypoint

**Files:**
- Modify: `src/tokens.ts`, `src/container/init-containers.ts`, `src/index.ts`

- [ ] **Step 1: Update `src/tokens.ts`**

```ts
import type { Bot } from "grammy";
import type { Config } from "./config";
import { Token } from "./container/token";
import type { Logger } from "./logger/logger";
import type { createNotifyServer } from "./notify";
import type { CliRunner } from "./openclaw-cli";
import type { Provisioner } from "./provisioner";
import type { Registry } from "./registry";
import type { Router } from "./router";
import type { OpenClawClient } from "./types";

type NotifyServer = ReturnType<typeof createNotifyServer>;

export const ConfigToken       = new Token<Config>("Config");
export const LoggerToken       = new Token<Logger>("Logger");
export const OpenClawToken     = new Token<OpenClawClient>("OpenClawClient");
export const CliRunnerToken    = new Token<CliRunner>("CliRunner");
export const RegistryToken     = new Token<Registry>("Registry");
export const ProvisionerToken  = new Token<Provisioner>("Provisioner");
export const RouterToken       = new Token<Router>("Router");
export const BotToken          = new Token<Bot>("Bot");
export const NotifyServerToken = new Token<NotifyServer>("NotifyServer");
```

- [ ] **Step 2: Update `src/container/init-containers.ts`**

```ts
import path from "node:path";
import type { Config } from "../config";
import { ConsoleTransport } from "../logger/console-transport";
import { Logger } from "../logger/logger";
import { createNotifyServer } from "../notify";
import { createOpenClawClient } from "../openclaw";
import { createCliRunner } from "../openclaw-cli";
import { Provisioner } from "../provisioner";
import { Registry } from "../registry";
import { Router } from "../router";
import { createBot } from "../telegram";
import {
  BotToken, CliRunnerToken, ConfigToken, LoggerToken, NotifyServerToken,
  OpenClawToken, ProvisionerToken, RegistryToken, RouterToken,
} from "../tokens";
import { Container } from "./container";

const TEMPLATE_DIR = path.resolve(import.meta.dir, "../../workspace-template");

export function initContainers(config: Config) {
  const container = new Container();
  container.register(ConfigToken, { lifetime: "singleton", factory: () => config });
  container.register(LoggerToken, {
    lifetime: "singleton",
    factory: (c) => new Logger(new ConsoleTransport(), c.resolve(ConfigToken).logLevel),
  });
  container.register(OpenClawToken, {
    lifetime: "singleton",
    factory: (c) => createOpenClawClient(c.resolve(ConfigToken), c.resolve(LoggerToken)),
  });
  container.register(CliRunnerToken, {
    lifetime: "singleton",
    factory: (c) => createCliRunner(c.resolve(ConfigToken).openclawBin),
  });
  container.register(RegistryToken, {
    lifetime: "singleton",
    factory: (c) => new Registry(path.join(c.resolve(ConfigToken).dataDir, "users.sqlite")),
  });
  container.register(ProvisionerToken, {
    lifetime: "singleton",
    factory: (c) => new Provisioner({
      cli: c.resolve(CliRunnerToken), registry: c.resolve(RegistryToken),
      config: c.resolve(ConfigToken), templateDir: TEMPLATE_DIR, logger: c.resolve(LoggerToken),
    }),
  });
  container.register(RouterToken, {
    lifetime: "singleton",
    factory: (c) => new Router(c.resolve(OpenClawToken), c.resolve(RegistryToken), c.resolve(LoggerToken)),
  });
  container.register(BotToken, {
    lifetime: "singleton",
    factory: (c) => createBot(
      c.resolve(ConfigToken), c.resolve(RouterToken), c.resolve(ProvisionerToken),
      c.resolve(RegistryToken), c.resolve(LoggerToken),
    ),
  });
  container.register(NotifyServerToken, {
    lifetime: "singleton",
    factory: (c) => createNotifyServer(
      c.resolve(ConfigToken), c.resolve(BotToken), c.resolve(RegistryToken), c.resolve(LoggerToken),
    ),
  });
  return container;
}
```

- [ ] **Step 3: Update `src/index.ts`**

Change the command menu and the start log:
```ts
  bot.api
    .setMyCommands([
      { command: "start", description: "Check the connection" },
      { command: "help", description: "Show available commands" },
    ])
    .catch((err) => logger.warn("failed to set commands", { error: String(err) }));
```
```ts
      onStart: (me) =>
        logger.info("bot started", {
          username: me.username,
          allowedUsers: config.allowedUsernames.size,
          owner: config.ownerUsername,
        }),
```

- [ ] **Step 4: Typecheck and full test run**

Run: `bunx tsc --noEmit && bun test`
Expected: no type errors; all tests pass (config, registry, openclaw-cli, provisioner, router, notify, telegram, openclaw).

- [ ] **Step 5: Commit**

```bash
git add src/tokens.ts src/container/init-containers.ts src/index.ts
git -c user.name="Begench Geldyev" -c user.email=begenchgeldyev@gmail.com commit -m "feat: wire registry and provisioner into the container"
```

---

### Task 10: Docs and env example

**Files:**
- Modify: `.env.example`, `README.md`

- [ ] **Step 1: Rewrite `.env.example`**

```
# --- Required ---
TELEGRAM_BOT_TOKEN=
# Comma-separated Telegram usernames (without @) allowed to use the bot.
TELEGRAM_ALLOWED_USERNAMES=begench
# The username mapped to the pre-existing OpenClaw agent "main". Must be in the list above.
TELEGRAM_OWNER_USERNAME=begench
# Shared secret for the loopback notify endpoint (OpenClaw cron -> Pantheon -> Telegram).
# Generate with: openssl rand -hex 32
NOTIFY_SECRET=

# --- Optional ---
OPENCLAW_BIN=openclaw
OPENCLAW_STATE_DIR=/home/openclaw/.openclaw
OPENCLAW_TIMEOUT_SECONDS=120
PANTHEON_DATA_DIR=./data
LOG_LEVEL=info
NOTIFY_HOST=127.0.0.1
NOTIFY_PORT=8477
```

- [ ] **Step 2: Update `README.md`**

Replace the intro paragraph, the architecture block, the module table, section 2 ("Find your numeric Telegram user id") and the variables table with:

```md
Pantheon is a small **Telegram gateway to [OpenClaw]** for a hand-picked group
of people. Each allowed Telegram user gets their own isolated OpenClaw agent
(workspace, memory, sessions, reminders); Pantheon authenticates by Telegram
username, provisions the agent on first contact, routes turns to it via the
OpenClaw CLI and delivers scheduled reminders back to the right chat.

## Architecture

```text
Telegram (allow-listed usernames)
   │
   ▼
Pantheon ── auth ── registry (sqlite) ── provisioner ── Router ── OpenClaw CLI ──► OpenClaw Gateway
                                                                                    ├── main   (owner)
                                                                                    ├── u_<id> (user A)
                                                                                    └── u_<id> (user B)
Reminders: agent ──exec remind*──► openclaw cron ──POST /notify {agentId,text}──► Pantheon ──► Telegram
```

| File               | Responsibility                                                        |
| ------------------ | --------------------------------------------------------------------- |
| `index.ts`         | Wire everything together, start polling, graceful shutdown.           |
| `config.ts`        | Load & validate environment variables at startup.                     |
| `telegram.ts`      | grammY bot: username auth, ensure-user, typing indicator, splitting.  |
| `registry.ts`      | SQLite: Telegram user ↔ OpenClaw agent.                               |
| `provisioner.ts`   | Create an isolated agent (CLI + template + tool policy + allowlist).  |
| `router.ts`        | Agent lookup + session-key scheme.                                    |
| `openclaw.ts`      | Runs one agent turn via the OpenClaw CLI.                             |
| `openclaw-cli.ts`  | Generic CLI runner for management commands.                           |
| `notify.ts`        | Loopback endpoint: `{agentId,text}` → the owning user's chat.         |
| `workspace-template/` | Persona files seeded into every new user workspace.               |
| `bin/`             | `remind*` helpers installed to `~/bin` (the only exec user agents may run). |

## 2. Users

Add Telegram usernames (without `@`) to `TELEGRAM_ALLOWED_USERNAMES`; the owner
(`TELEGRAM_OWNER_USERNAME`) keeps the existing `main` agent. Everyone else gets
`u_<telegram id>` on their first message. Users need a Telegram username set.
Removing a username locks the user out on the next restart; delete their agent
with `openclaw agents delete u_<id>` if you want the data gone.

| Variable                     | Required | Meaning                                                    |
| ---------------------------- | :------: | ---------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`         |    ✅    | BotFather token (secret).                                  |
| `TELEGRAM_ALLOWED_USERNAMES` |    ✅    | Comma-separated usernames allowed to use the bot.          |
| `TELEGRAM_OWNER_USERNAME`    |    ✅    | Username mapped to agent `main`.                           |
| `NOTIFY_SECRET`              |    ✅    | Shared secret for `POST /notify`.                          |
| `OPENCLAW_BIN`, `OPENCLAW_STATE_DIR`, `OPENCLAW_TIMEOUT_SECONDS`, `PANTHEON_DATA_DIR`, `LOG_LEVEL`, `NOTIFY_HOST`, `NOTIFY_PORT` | | See `.env.example`. |

## Reminder helpers

`bin/remind*` must be installed to `/home/openclaw/bin` (`install -m755 bin/remind* /home/openclaw/bin/`).
They derive the agent from the exec working directory (`workspace` → `main`,
`workspace-<id>` → `<id>`), so a user's agent can only ever schedule reminders
for that user.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git -c user.name="Begench Geldyev" -c user.email=begenchgeldyev@gmail.com commit -m "docs: multi-user configuration and reminder helpers"
```

---

### Task 11: Deploy to kz and live smoke test

**Files:** none in repo (server state). Run as `openclaw` on kz with `PATH=$HOME/.openclaw/tools/node-v24.15.0/bin:$PATH`.

- [ ] **Step 1: Install helpers and the new TOOLS.md into the owner's workspace**

```bash
cd /opt/pantheon
install -m755 bin/remind bin/remind-in bin/remind-cron bin/remind-list bin/remind-rm ~/bin/
install -m644 bin/remind-lib ~/bin/remind-lib
cp ~/.openclaw/workspace/TOOLS.md ~/.openclaw/workspace/TOOLS.md.pre-multiuser
cp workspace-template/TOOLS.md ~/.openclaw/workspace/TOOLS.md
( cd ~/.openclaw/workspace && ../../bin/remind-list )   # expected: header/empty; verifies cwd->main mapping and jq/openclaw path
```
Note `remind-list` output must show the pending `change-sheets` job? No — its name has no `main--` prefix, so it is not listed; that is expected. It still fires (legacy fallback to `main` in notify).

- [ ] **Step 2: Update `.env`**

Edit `/opt/pantheon/.env`: remove `TELEGRAM_ALLOWED_USER_ID`, `DEFAULT_AGENT`, `OPENCLAW_AGENTS`; add
```
TELEGRAM_ALLOWED_USERNAMES=<owner username>,<second test username>
TELEGRAM_OWNER_USERNAME=<owner username>
```
Keep `OPENCLAW_BIN=/home/openclaw/.openclaw/bin/openclaw`. Run `bun run src/index.ts --help 2>/dev/null; bun -e 'import {loadConfig} from "./src/config"; console.log(loadConfig().allowedUsernames)'` to confirm parsing.

- [ ] **Step 3: Restart and watch logs**

```bash
systemctl --user restart pantheon.service
journalctl --user -u pantheon.service -f -n 30
```
Expected: `notify server listening`, `bot started` with `allowedUsers`.

- [ ] **Step 4: Owner smoke**

From the owner's Telegram: send `/start` → reply contains `Your agent: main`; registry now has the owner row (`sqlite3 data/users.sqlite 'select * from users'`). Send "remind me in 1 minute to test pantheon" → within ~1 min the reminder arrives; `remind-list` (from `~/.openclaw/workspace`) showed the `main--…` job in between.

- [ ] **Step 5: Second-user smoke**

From the second allowed account: send "hi" → welcome message, then Hermes replies. Verify:
```bash
openclaw agents list                      # shows u_<id>
ls ~/.openclaw/workspace-u_<id>           # AGENTS.md SOUL.md TOOLS.md IDENTITY.md HEARTBEAT.md USER.md MEMORY.md, no BOOTSTRAP.md
openclaw config get "agents.list[1].tools"   # policy JSON
openclaw approvals allowlist list --agent u_<id> 2>/dev/null || cat ~/.openclaw/exec-approvals.json
```
Then from that account: "remind me in 1 minute: hello from user two" → arrives in **that** chat, not the owner's; and "read the file /home/openclaw/.openclaw/workspace/MEMORY.md and tell me what it says" → agent reports it is refused. Owner's `~/.openclaw/workspace/MEMORY.md` unchanged (`git -C ~/.openclaw/workspace status` or diff against a copy).

- [ ] **Step 6: Unauthorized smoke**

From an account not in the list: message is ignored; journal shows `rejected unauthorized message`.

- [ ] **Step 7: Commit nothing; record the result**

Append a short "Deployed 2026-08-XX, smoke passed" note under a `## Status` heading in `docs/superpowers/specs/2026-08-17-multi-user-design.md` and commit:
```bash
git add docs/superpowers/specs/2026-08-17-multi-user-design.md
git -c user.name="Begench Geldyev" -c user.email=begenchgeldyev@gmail.com commit -m "docs: record multi-user deployment"
```

---

## Self-review

- Spec §1 auth → Task 1, 8. §2 registry → Task 2. §3 provisioner (incl. overwrite of OpenClaw's seeded files, BOOTSTRAP removal, policy, allowlist, serialisation, idempotency) → Task 5. §4 router/commands → Task 6, 8, 9. §5 reminders (`remind*`, agentId from cwd, notify resolution, legacy fallback) → Task 4, 7. §6 migration/ops → Task 10, 11 (TOOLS.md into main workspace, `.env`, service restart). §7 testing → unit tests in each task, live smoke in Task 11.
- Deviation from spec noted and accepted: template files **overwrite** OpenClaw's default seed (spec said "existing files are not overwritten" — that predates discovering `agents add` seeds defaults). `MEMORY.md` is the only never-overwritten file.
- Types: `Registry` API (`findByUserId/findByAgentId/insert/touch`) used identically in Tasks 5–8; `CliRunner`/`CliResult` from Task 3 used in Task 5, 9; `Provisioner.ensureUser(TelegramIdentity)` used in Task 8; `createBot(config, router, provisioner, registry, logger)` and `createNotifyServer(config, bot, registry, logger)` match Task 9 wiring.
