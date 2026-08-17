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

## Requirements

- A Linux VPS that already runs **OpenClaw** (Pantheon runs on the *same* host).
- **Bun** (`curl -fsSL https://bun.sh/install | bash`).
- A Telegram bot token and your numeric Telegram user id (below).

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
chmod 600 .env        # the token is a secret
```

| Variable                     | Required | Meaning                                                    |
| ---------------------------- | :------: | ---------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`         |    ✅    | BotFather token (secret).                                  |
| `TELEGRAM_ALLOWED_USERNAMES` |    ✅    | Comma-separated usernames allowed to use the bot.          |
| `TELEGRAM_OWNER_USERNAME`    |    ✅    | Username mapped to agent `main`.                           |
| `NOTIFY_SECRET`              |    ✅    | Shared secret for `POST /notify`.                          |
| `OPENCLAW_BIN`, `OPENCLAW_STATE_DIR`, `OPENCLAW_TIMEOUT_SECONDS`, `PANTHEON_DATA_DIR`, `LOG_LEVEL`, `NOTIFY_HOST`, `NOTIFY_PORT` | | See `.env.example`. |

`.env` is git-ignored and never committed. The only secret is the bot token —
the OpenClaw CLI runs locally under your own credentials.

## 5. Development

```bash
bun run dev        # watch mode
bun run typecheck  # tsc --noEmit
bun test           # unit tests
bun run start      # run once (foreground)
```

## 6. Reminder helpers

`bin/remind*` must be installed to `/home/openclaw/bin` (`install -m755 bin/remind* /home/openclaw/bin/`).
They derive the agent from the exec working directory (`workspace` → `main`,
`workspace-<id>` → `<id>`), so a user's agent can only ever schedule reminders
for that user.

## 7. Production (systemd)

`pantheon.service` is included. Before enabling it:

1. **Find Bun** and set `ExecStart` accordingly:
   ```bash
   which bun    # e.g. /usr/local/bin/bun or /home/pantheon/.bun/bin/bun
   ```
2. Set `User`/`Group`, `WorkingDirectory`, and `EnvironmentFile` to match your
   install. Running as a dedicated **non-root** user is recommended:
   ```bash
   sudo useradd --system --home-dir /opt/pantheon --shell /usr/sbin/nologin pantheon
   sudo chown -R pantheon:pantheon /opt/pantheon
   ```
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

The service user must be able to run the OpenClaw CLI (same host, same
credentials OpenClaw expects).

## 8. Logs & troubleshooting

Pantheon logs one JSON object per line to the journal:

```bash
journalctl -u pantheon -f              # follow
journalctl -u pantheon -n 200 --no-pager
```

Key events: `bot started`, `authorized message received`,
`rejected unauthorized message`, `selected agent`, `openclaw request started`,
`openclaw response completed`, `openclaw request failed`. Logs contain metadata
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
openclaw agent --agent hermes --session-key pantheon-test \
  --message "Reply with exactly: PANTHEON_OK" --json
```

If the reply text isn't found automatically, note which key holds it and adjust
the field list in `extractResponseText()` (`src/openclaw.ts`). That is the only
place response-shape assumptions live.

[OpenClaw]: #
