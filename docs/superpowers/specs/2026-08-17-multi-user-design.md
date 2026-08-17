# Pantheon multi-user design

Date: 2026-08-17
Status: approved

## Goal

Let a configurable set of Telegram users (identified by username) talk to Pantheon,
each with a fully isolated OpenClaw agent: own memory, own sessions, own reminders.
The owner keeps the existing `main` (Hermes) agent untouched. Model access
(CLIProxyAPI) stays shared.

## Non-goals

- Open/public registration, invite codes, admin commands.
- Per-user quotas or rate limits (allowlisted friends; shared CLIProxyAPI is accepted).
- Per-user Google Calendar. Only `main` keeps the calendar MCP.
- Multiple personas per user (may return later as `u_<tgid>_<persona>`).

## Current state (kz)

- `/opt/pantheon` (Bun + grammY) allow-lists one numeric id, shells out to
  `openclaw agent --agent <id> --session-key telegram:<uid>:<chat> …`.
- OpenClaw gateway runs one agent `main` with workspace `~/.openclaw/workspace`,
  global `mcp.servers.google-calendar`, global cron.
- `~/bin/remind`, `~/bin/remind-in` create cron jobs that POST `{text}` to
  Pantheon `/notify`; `notify.ts` falls back to the owner's chat.

## Design

### 1. Auth & identity

- `.env`: `TELEGRAM_ALLOWED_USERNAMES=begench,amina` (comma-separated, case-insensitive,
  no `@`), `TELEGRAM_OWNER_USERNAME=begench`. `TELEGRAM_ALLOWED_USER_ID`, `DEFAULT_AGENT`,
  `OPENCLAW_AGENTS` are removed. Owner username must be in the allowed list (validated).
- Middleware: `ctx.from.username` (lower-cased) must be in the allowed set; otherwise the
  update is ignored silently (logged at warn, as today). Users without a Telegram
  username cannot use the bot.
- Removing a username from the list locks that user out on next restart; their agent and
  data stay on disk (manual cleanup with `openclaw agents delete`).

### 2. Registry (`src/registry.ts`)

- `bun:sqlite` DB at `PANTHEON_DATA_DIR/users.sqlite` (default `/opt/pantheon/data`,
  git-ignored).
- Table `users(tg_user_id INTEGER PRIMARY KEY, username TEXT NOT NULL, agent_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen TEXT NOT NULL)`.
- API: `findByUserId(id)`, `findByAgentId(agentId)`, `upsert(user)`, `touch(id)`.
- Purpose: numeric-id → agent mapping (a username rename must not create a second
  agent) and agent → chat lookup for reminders. Private chat id == Telegram user id.
- Owner: on first message from `TELEGRAM_OWNER_USERNAME`, row is created with
  `agent_id = "main"` (no provisioning).

### 3. Provisioner (`src/provisioner.ts`)

Triggered on the first message from an allowed user with no registry row (non-owner).
Idempotent: every step checks before acting so a crash mid-way can be retried.

1. `openclaw agents add u_<tgid> --workspace ~/.openclaw/workspace-u_<tgid> --non-interactive`
   (skip if agent already exists per `openclaw agents list --json`).
2. Copy `/opt/pantheon/workspace-template/*.md` into the workspace (`AGENTS.md`,
   `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `HEARTBEAT.md`), write `USER.md` with the
   Telegram first name / username and an empty `MEMORY.md`. Existing files are not
   overwritten.
3. `openclaw config patch --stdin` with per-agent policy on `agents.list[]` entry `u_<tgid>`:
   ```json5
   {
     tools: {
       fs: { workspaceOnly: true },
       deny: ["google-calendar__*", "group:sessions", "group:web", "group:nodes", "group:ui"],
       exec: { security: "allowlist", ask: "off" },
     },
   }
   ```
   plus exec allowlist entries for `/home/openclaw/bin/remind` and
   `/home/openclaw/bin/remind-in` (via `openclaw approvals allowlist add` or the
   equivalent config path — exact mechanism confirmed during implementation with
   `openclaw sandbox explain --agent u_<tgid>`; if the allowlist turns out to be
   host-global, apply it globally: `main` only needs the same two scripts).
4. Insert registry row, reply with a short welcome.

Provisioning runs under a per-user in-process lock so two quick messages don't race.
Failure → user gets the generic error message, nothing is inserted, next message retries.

Because `agents.*`, `tools.*` and `mcp.*` hot-reload, no gateway restart is needed.

### 4. Router / Telegram

- `Router.route({userId, chatId, text})`: `agentId = registry.findByUserId(userId).agent_id`;
  session key unchanged `telegram:<uid>:<chat>`.
- Removed: `/agent`, `/agents`, per-agent one-shot commands, in-memory selection map,
  `OPENCLAW_AGENTS`, `DEFAULT_AGENT`. Remaining commands: `/start`, `/help`.
- Telegram handler order: auth middleware → ensure-user middleware (registry lookup /
  provision) → commands / text.

### 5. Reminders

- `~/bin/remind`: derive agent id from `$PWD`: basename `workspace` → `main`,
  `workspace-<id>` → `<id>`; anything else → exit 3. Pass `--agent <id>` to
  `openclaw cron add`, name jobs `<agentId>--<slug>`, POST `{agentId, text}`.
- `notify.ts`: body must contain `agentId` (string) and `text`; resolve chat via
  `registry.findByAgentId` → `tg_user_id`; unknown agent → 404. Owner fallback removed.
- OpenClaw exec runs with cwd = agent workspace, so this attribution cannot be steered
  by the user's prompt.

### 6. Migration / ops

- Nothing moves. `main` keeps its workspace, MEMORY.md, calendar MCP and pending cron job.
  Global `tools.exec` stays as is, so `main`'s behaviour is unchanged.
- `.env.example`, `README.md` updated; `pantheon.service` unchanged; `data/` git-ignored.
- `workspace-template/` is versioned in the repo and derived from the current `main`
  workspace with owner-specific text removed.

### 7. Testing

- Unit (bun test): username normalisation/allowlist, registry CRUD (in-memory sqlite),
  router uses registry agent, notify resolves `agentId` and rejects unknown/missing,
  agent-id-from-cwd rule (script tested via a bash test or a TS port of the rule).
- Live smoke on kz with a second Telegram account: first message provisions
  `u_<tgid>`; "remind me in 1 minute" lands in that user's chat; owner's MEMORY.md and
  cron list unaffected; `openclaw sandbox explain --agent u_<tgid>` shows fs
  workspace-only and exec allowlist; asking the agent to read `~/.openclaw/workspace/MEMORY.md`
  is refused.
