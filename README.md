# Pantheon

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
Reminders: agent ──exec its own remind wrapper──► openclaw cron ──POST /notify {agentId,text}──► Pantheon ──► Telegram
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
| `bin/remind-impl/` | The real `remind*` helpers; take the agent id as their first argument. |
| `bin/install-remind-wrappers` | Writes an agent's wrapper scripts (id baked in) into a directory. |
| `container/`       | Tiny DI container wiring the modules together (`init-containers.ts`). |
| `logger/`          | Structured JSON logging (metadata only, never secrets).           |
| `tokens.ts`        | DI tokens.                                                        |
| `types.ts`         | Shared types / the `OpenClawClient` interface.                    |

## Requirements

- A Linux VPS that already runs **OpenClaw** (Pantheon runs on the *same* host).
- **Bun** (`curl -fsSL https://bun.sh/install | bash`).
- A Telegram bot token and the Telegram usernames of the people allowed to use it (below).

Pantheon calls the OpenClaw CLI locally — there is no SSH, no HTTP between
Pantheon and OpenClaw, and no database.

## 1. Create the bot (BotFather)

1. In Telegram, open [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, choose a name and a username ending in `bot`.
3. Copy the **token** it gives you — this goes in `TELEGRAM_BOT_TOKEN`.

## 2. Users

Add Telegram usernames (without `@`) to `TELEGRAM_ALLOWED_USERNAMES`; the owner
(`TELEGRAM_OWNER_USERNAME`) keeps the existing `main` agent. Everyone else gets
`u_<telegram id>` on their first message. Users need a Telegram username set.
Removing a username locks the user out on the next restart; delete their agent
with `openclaw agents delete u_<id>` if you want the data gone.

## 3. Install

```bash
git clone <your-repo> /opt/pantheon
cd /opt/pantheon
bun install
```

## 4. Configure

```bash
cp .env.example .env
$EDITOR .env          # fill in the values below
chmod 600 .env        # it holds the bot token and the notify secret
```

| Variable                     | Required | Meaning                                                    |
| ---------------------------- | :------: | ---------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`         |    ✅    | BotFather token (secret).                                  |
| `TELEGRAM_ALLOWED_USERNAMES` |    ✅    | Comma-separated usernames allowed to use the bot.          |
| `TELEGRAM_OWNER_USERNAME`    |    ✅    | Username mapped to agent `main`.                           |
| `NOTIFY_SECRET`              |    ✅    | Shared secret for `POST /notify`.                          |
| `OPENCLAW_BIN`, `OPENCLAW_STATE_DIR`, `OPENCLAW_TIMEOUT_SECONDS`, `PANTHEON_DATA_DIR`, `PANTHEON_BIN_DIR`, `REMIND_IMPL_DIR`, `LOG_LEVEL`, `NOTIFY_HOST`, `NOTIFY_PORT` | | See `.env.example`. |

`.env` is git-ignored and never committed. It holds two secrets — the bot token
and `NOTIFY_SECRET` — so keep it `chmod 600`. The OpenClaw CLI itself runs
locally under the service user's own credentials.

## 5. Development

```bash
bun run dev        # watch mode
bun run typecheck  # tsc --noEmit
bun test           # unit tests
bun run start      # run once (foreground)
```

## 6. Reminder helpers

Agents schedule reminders by exec'ing small wrapper scripts. Layout on the
OpenClaw host:

```text
/home/openclaw/bin/remind-impl/          # the real scripts (remind, remind-in, …)
/home/openclaw/bin/remind*               # the owner's wrappers  -> agent main
/home/openclaw/bin/agents/u_<id>/remind* # one user's wrappers   -> agent u_<id>
```

Each wrapper is two lines and pins the agent id:

```sh
#!/bin/sh
exec /home/openclaw/bin/remind-impl/remind-in u_42 "$@"
```

**Why wrappers.** Agent attribution must not be derivable from anything the
agent controls. The working directory is not trustworthy (OpenClaw's exec tool
honours a caller-supplied `workdir`), and neither is the environment (agents may
pass env overrides). The only unforgeable primitive is OpenClaw's **per-agent
exec allowlist**: agent `u_42` is allowed to exec
`/home/openclaw/bin/agents/u_42/remind*` and nothing else — not the
implementations, not another user's wrapper directory. Because the wrapper
hard-codes `u_42`, a user's agent can only ever schedule (and list, and cancel)
reminders for itself. The implementations additionally set an explicit `PATH`,
validate the agent id (`main` or `u_<digits>`), the job name
(`[a-z0-9][a-z0-9-]{0,63}`) and the timestamp/cron expression before calling
`openclaw`.

Deploy:

```bash
# 1. implementations
sudo install -d -m755 /home/openclaw/bin/remind-impl
sudo install -m755 bin/remind-impl/remind* /home/openclaw/bin/remind-impl/
sudo install -m644 bin/remind-impl/remind-lib /home/openclaw/bin/remind-impl/remind-lib
sudo install -m755 bin/install-remind-wrappers /home/openclaw/bin/

# 2. the owner's wrappers, on the gateway PATH
sudo -u openclaw /home/openclaw/bin/install-remind-wrappers main /home/openclaw/bin

# 3. the owner's TOOLS.md (user workspaces get theirs from the provisioner)
sed 's|{{REMIND_BIN}}|/home/openclaw/bin|g' workspace-template/TOOLS.md.tmpl \
  | sudo -u openclaw tee /home/openclaw/.openclaw/workspace/TOOLS.md >/dev/null
```

Pantheon installs each new user's wrappers itself (into
`PANTHEON_BIN_DIR/agents/<agent-id>/`, byte-identical to what
`install-remind-wrappers` writes) and adds the matching allowlist entry with
`openclaw approvals allowlist add`.

Requirements on the OpenClaw host:

- `jq` and `column` (util-linux) must be installed — the helpers build the JSON
  body with `jq` and `remind-list` formats with `column`.
- `PANTHEON_NOTIFY_SECRET` must be set **in the OpenClaw gateway's
  environment**, because the cron job's command reads it at fire time. Configure
  it in `openclaw.json` under `env` and give it the same value as Pantheon's
  `NOTIFY_SECRET`:

  ```json5
  { env: { PANTHEON_NOTIFY_SECRET: "<same value as NOTIFY_SECRET>" } }
  ```

  Without it the reminder POST is rejected with 401 and never reaches Telegram.

## 7. Production (systemd)

`pantheon.service` is included. Before enabling it:

1. **Find Bun** and set `ExecStart` accordingly:
   ```bash
   which bun    # e.g. /usr/local/bin/bun or /home/openclaw/.bun/bin/bun
   ```
2. Set `WorkingDirectory` and `EnvironmentFile` to match your install. **Run
   Pantheon as the same user as the OpenClaw gateway** (`openclaw` in the shipped
   unit): the provisioner writes agent workspaces into that user's
   `~/.openclaw/workspace-*` and mutates OpenClaw's config through the CLI, so a
   separate `pantheon` user would provision agents the gateway cannot see. Adjust
   `User`/`Group` only if your OpenClaw user is named differently:
   ```bash
   sudo chown -R openclaw:openclaw /opt/pantheon
   ```
   If OpenClaw itself runs as a **systemd user unit** (`systemctl --user`), run
   Pantheon the same way instead: drop the `User`/`Group` lines, install the unit
   to `~/.config/systemd/user/pantheon.service`, use
   `WantedBy=default.target`, and enable it with
   `systemctl --user enable --now pantheon` (plus `loginctl enable-linger openclaw`
   so it starts at boot).
3. Install and start:
   ```bash
   sudo cp pantheon.service /etc/systemd/system/pantheon.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now pantheon
   ```

The unit restarts on failure, starts after the network is up, and loads config
from `.env`. Extra sandbox hardening is included but commented out, because it
can interfere with the `openclaw` CLI reaching its local gateway — enable those
options one at a time and confirm OpenClaw still works.

The service user must be able to run the OpenClaw CLI (same host, same user as
the OpenClaw gateway, so the CLI sees the same state dir and config).

## 8. Logs & troubleshooting

Pantheon logs one JSON object per line to the journal:

```bash
journalctl -u pantheon -f              # follow
journalctl -u pantheon -n 200 --no-pager
```

Key events: `bot started`, `rejected unauthorized message`, `provisioning agent`,
`provisioned agent`, `openclaw request started`, `openclaw response completed`,
`openclaw request failed`, `notify delivered`, `notify rejected`. Logs contain metadata
only (user id, agent, duration, error type) — never message bodies or secrets.

| Symptom                              | Likely cause / fix                                        |
| ------------------------------------ | --------------------------------------------------------- |
| Exits immediately with a config error| A required env var is missing/invalid — the message says which. |
| Bot ignores you                      | Check `rejected` log; username may not be in `TELEGRAM_ALLOWED_USERNAMES`. |
| Every reply is the generic error     | Run the OpenClaw command by hand (below) and check stderr in the log. |
| `Could not find reply text …`        | OpenClaw's JSON shape differs — see next section.         |

## How the OpenClaw integration works

`src/openclaw.ts` is the single adapter. For each turn it runs, via
`Bun.spawn()` with an **argument array** (never a shell string, so Telegram text
can't inject flags or commands):

```bash
openclaw agent \
  --agent <agent-id> \
  --session-key telegram:<user-id>:<chat-id> \
  --message <your text> \
  --timeout <seconds> \
  --json
```

- **Sessions / memory:** the `--session-key` (`telegram:<user>:<chat>`) groups a
  conversation. OpenClaw owns the actual memory behind that key, so Pantheon
  stores no history and needs no database. OpenClaw isolates sessions per agent
  when `--agent` is given, so one key works across agents.
- **Agent mapping:** each Telegram user is mapped to an OpenClaw agent in the
  SQLite registry. The owner gets agent `main`; other users get `u_<id>`. A user
  is provisioned the first time they message the bot.
- **Response parsing** lives in one function, `extractResponseText()`, because
  the exact `--json` shape has **not yet been verified against a live
  OpenClaw**. It tries the common field names and fails loudly (logging the
  observed keys) if none match.

### Verify the JSON shape on the VPS (one-time)

This dev environment has no OpenClaw, so run this once on the VPS and check the
output:

```bash
openclaw agent --agent main --session-key pantheon-test \
  --message "Reply with exactly: PANTHEON_OK" --json
```

If the reply text isn't found automatically, note which key holds it and adjust
the field list in `extractResponseText()` (`src/openclaw.ts`). That is the only
place response-shape assumptions live.

[OpenClaw]: #

## Gods

Pantheon can host more than one god behind the single bot. The owner talks to
**Hermes** (`main`, dates & reminders) by default and may summon others.

- `/gods` — list the gods you may summon (the active one is marked ▸).
- `/hermes [message]`, `/athena [message]`, … — switch to a god (and optionally
  speak to it in the same message). The choice is sticky per chat until you
  switch again.
- Send a **file** (e.g. your résumé) and it lands in the active god's workspace
  `inbox/`, then that god is told about it.

Non-owner users are unaffected: they have exactly one god (their own agent) and
see no god commands.

### Adding a god

1. Create the agent and its workspace:
   ```bash
   openclaw agents add <id> --workspace ~/.openclaw/workspace-<id> --non-interactive
   rm -f ~/.openclaw/workspace-<id>/BOOTSTRAP.md
   ```
2. Install its persona from `gods/<id>/` into that workspace (render `{{NAME}}` /
   `{{USERNAME}}` in `USER.md`).
3. Grant it the tools it needs and deny what it must not touch, e.g. for a
   web-using god keep Hermes's calendar to Hermes:
   ```bash
   openclaw config set 'agents.list[<n>].tools' '{deny:["google-calendar__*"]}'
   ```
4. Add its id to `PANTHEON_OWNER_GODS` and restart Pantheon.

### Athena — the vacancy hunt (Phase 1)

`gods/athena/` is the job-hunt god. She is **web-enabled** (fetches job-board
JSON APIs — Greenhouse/Lever/Ashby boards, Remotive, RemoteOK, We Work Remotely,
HN "Who's Hiring") and configured entirely by conversation: tell her what you're
hunting and send your résumé, and she records it in her own workspace. Phase 1
is **on-demand** — she finds and ranks real roles and weaves a tailored résumé +
cover letter on request. Proactive scheduled updates and any auto-apply are
later phases (auto-submission is deliberately not built here).

### Voice notes

Send a voice message and Pantheon transcribes it (Groq Whisper), echoes what it
heard, then routes the transcript through the pantheon exactly like a typed
message. Set `GROQ_API_KEY` (a free key from console.groq.com) to enable it;
without it, voice notes get a polite "not set up" reply. `GROQ_MODEL` defaults to
`whisper-large-v3`.
