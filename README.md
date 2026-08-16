# Pantheon

Pantheon is a small, private **Telegram gateway to [OpenClaw]**. It receives
your Telegram messages, checks that they came from you, routes them to the
right OpenClaw agent, runs a single agent turn via the OpenClaw CLI, and sends
the reply back to Telegram.

Pantheon is deliberately thin. Agents, memory, reasoning, tools, and model
access all stay inside OpenClaw.

## Architecture

```text
Telegram
   │  (long polling)
   ▼
Pantheon ── auth (allowlist) ── Router ── OpenClaw CLI ──► OpenClaw Gateway
                                                              ├── Hermes
                                                              ├── … other agents
                                                              └── future agents
```

Module responsibilities (`src/`):

| File           | Responsibility                                                   |
| -------------- | ---------------------------------------------------------------- |
| `index.ts`     | Wire everything together, start polling, graceful shutdown.      |
| `config.ts`    | Load & validate environment variables at startup.                |
| `telegram.ts`  | grammY bot: auth, commands, typing indicator, message splitting. |
| `router.ts`    | Agent selection + session-key scheme. No Telegram/OpenClaw guts. |
| `openclaw.ts`  | The **only** place that talks to OpenClaw (CLI adapter).         |
| `logger.ts`    | Structured JSON logging (metadata only, never secrets).          |
| `types.ts`     | Shared types / the `OpenClawClient` interface.                   |

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

## 2. Find your numeric Telegram user id

Usernames can change, so Pantheon authenticates on your **numeric id**.

- Message [@userinfobot](https://t.me/userinfobot) (or `@RawDataBot`) and read
  the `id` it returns, **or**
- After first configuring Pantheon, send it a message and read the
  `authorized message received` / `rejected unauthorized message` log line —
  it contains the `fromId`. Put that in `TELEGRAM_ALLOWED_USER_ID`.

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

| Variable                   | Required | Meaning                                                       |
| -------------------------- | :------: | ------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`       |    ✅    | BotFather token (secret).                                     |
| `TELEGRAM_ALLOWED_USER_ID` |    ✅    | Your numeric Telegram user id.                                |
| `DEFAULT_AGENT`            |    ✅    | Agent used when none is selected (e.g. `hermes`).             |
| `OPENCLAW_AGENTS`          |          | Comma-separated known agents. `DEFAULT_AGENT` always included.|
| `OPENCLAW_BIN`             |          | OpenClaw CLI name or path. Default `openclaw`.                |
| `OPENCLAW_TIMEOUT_SECONDS` |          | Per-turn timeout. Default `120`.                              |
| `LOG_LEVEL`                |          | `debug`\|`info`\|`warn`\|`error`. Default `info`.             |

`.env` is git-ignored and never committed. The only secret is the bot token —
the OpenClaw CLI runs locally under your own credentials.

## 5. Development

```bash
bun run dev        # watch mode
bun run typecheck  # tsc --noEmit
bun test           # unit tests
bun run start      # run once (foreground)
```

## Commands

| Command               | Behaviour                                                        |
| --------------------- | --------------------------------------------------------------- |
| `/start`              | Confirm Pantheon is connected; show the active agent.           |
| `/help`               | List commands.                                                  |
| `/agents`             | List the configured agents.                                     |
| `/agent <name>`       | Select the active agent for this chat.                          |
| `/<agent> <message>`  | Send **one** message to a specific agent without switching.     |
| _any other text_      | Goes to your currently selected agent (or `DEFAULT_AGENT`).     |

The `/<agent>` shortcuts are generated from `OPENCLAW_AGENTS` — nothing is
hardcoded. Only agent ids that are valid Telegram commands (`[a-z0-9_]`) get a
shortcut.

## 6. Production (systemd)

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

## 7. Logs & troubleshooting

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
| Bot ignores you                      | Wrong `TELEGRAM_ALLOWED_USER_ID`; check `rejected` log.   |
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
- **Selected agent** is kept in memory only (a `chat → agent` map). A restart
  just falls back to `DEFAULT_AGENT`; nothing important is lost.
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

## 8. Adding more agents later

1. Make sure the agent exists in OpenClaw.
2. Add its id to `OPENCLAW_AGENTS` in `.env` (comma-separated).
3. Restart: `sudo systemctl restart pantheon`.

The agent then appears in `/agents`, can be chosen with `/agent <id>`, and (if
its id is a valid command) gets a `/<id> …` one-shot shortcut. Automatic
"smart" routing can later be added inside `Router.route()` without touching the
Telegram or OpenClaw layers.

[OpenClaw]: #
