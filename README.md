# Pantheon

Pantheon is the owner's household of [OpenClaw] agents — the "gods" — reached
through Telegram. OpenClaw's own Telegram channel now carries every message; this
repository holds what OpenClaw does not ship: the gods' persona templates
(`gods/`), the template for a non-owner user's own agent (`workspace-template/`),
the reminder helpers and the morning-standup intake (`bin/`), and the laptop half
of the standup (`laptop/`).

## History

Until October 2026 this repository was also a Bun service (grammY bot) in front
of OpenClaw: it authenticated users by username, provisioned an agent per user,
routed the owner's messages between gods (pin → keywords → LLM classifier),
transcribed voice notes, saved uploads to `inbox/`, and delivered reminders and
god-to-god word through loopback `/notify` and `/tell` endpoints. OpenClaw
2026.9.7 does all of that natively, so the service (`src/`, Docker files,
`pantheon.service`) was retired and deleted. The migration design and cutover are
in `docs/superpowers/specs/2026-09-30-native-telegram-migration-design.md`.

## Architecture

```text
Telegram (owner) ──► OpenClaw channels.telegram ── binding ──► zeus (agent:zeus:main)
                                                                   │ sessions_send
                                                                   ▼
Telegram ◄── message tool ── specialist (agent:main:main = Hermes, agent:athena:main, …)

Reminders: god ──exec its own wrapper──► bin/remind-impl ──► openclaw cron add
           (command job: /bin/cat <text>) ──► OpenClaw announces stdout ──► Telegram

Standup:   laptop timer ── laptop/seneca-standup (collect.sh → claude -p) ──ssh──► bin/standup-intake
           ──► standups/<date>.md + openclaw agent --agent seneca --deliver ──► Telegram
```

Only the owner has a pantheon. A non-owner user would get one isolated `u_<id>`
agent bound to their own chat (see [Adding a user](#adding-a-user)).

| Path | What it is |
|---|---|
| `gods/<id>/` | Persona templates for zeus, athena, heracles, aphrodite, seneca (`{{NAME}}`, `{{USERNAME}}`, `{{REMIND_BIN}}`, `{{CHAT_ID}}`). |
| `workspace-template/` | Persona template for a non-owner user's own agent (Hermes-style). |
| `bin/remind-impl/` | The real `remind*` helpers; they take the agent id as their first argument. |
| `bin/install-remind-wrappers` | Writes an agent's wrapper scripts (agent id baked in). |
| `bin/remind.test.sh` | Tests for the helpers: `bash bin/remind.test.sh` → `OK`. |
| `bin/standup-intake` | Receives the morning standup from the laptop and has Seneca deliver it. |
| `bin/standup-intake.test.sh` | Its tests: `bash bin/standup-intake.test.sh` → `OK`. |
| `laptop/` | The laptop half of the standup: `seneca-standup`, its systemd user units, its tests. |
| `.github/workflows/deploy.yml` | Deploys the helpers to the server on push to `main`. |

## Setup

Everything below runs on the OpenClaw host as the `openclaw` user, on OpenClaw
2026.9.7 or later. The helpers also need `jq` and `column` (util-linux).

### 1. Bot token

Keep the token out of shell history and readable only by `openclaw`:

```bash
(umask 077; read -rsp 'bot token: ' T && printf '%s' "$T" > ~/.openclaw/telegram-bot-token); echo
```

### 2. Channel and binding

Only one process may poll a bot token. A second poller shows up as HTTP 409 in
the gateway log.

```bash
openclaw config set channels.telegram '{"tokenFile":"/home/openclaw/.openclaw/telegram-bot-token","dmPolicy":"allowlist","allowFrom":["<OWNER_TG_ID>"],"groupPolicy":"allowlist"}' --strict-json
openclaw config set bindings '[{"agentId":"zeus","match":{"channel":"telegram","peer":{"kind":"direct","id":"<OWNER_TG_ID>"}}}]' --strict-json --replace
openclaw agents list --bindings     # zeus ← telegram direct <OWNER_TG_ID>
```

`allowFrom` takes numeric Telegram user ids, not usernames. Groups stay blocked.
Per-chat bindings go through `config set bindings`; `openclaw agents bind` only
binds whole channels.

### 3. Agent-to-agent

```bash
openclaw config set tools.agentToAgent '{"enabled":true,"allow":["zeus","main","athena","heracles","aphrodite","seneca"]}' --strict-json
```

Both sender and target must be in `allow`, so `u_*` agents can neither reach nor
be reached by the owner's gods.

### 4. Voice notes

```bash
openclaw plugins install @openclaw/groq-provider
(umask 077; read -rsp 'groq key: ' K && printf 'GROQ_API_KEY=%s\n' "$K" >> ~/.openclaw/.env); echo
openclaw gateway restart            # the gateway reads ~/.openclaw/.env at start
openclaw config set tools.media.models '[{"provider":"groq","model":"whisper-large-v3","capabilities":["audio"]}]' --strict-json
```

### 5. Tool policies

Set at `agents.entries.<id>.tools`, e.g.
`openclaw config set agents.entries.zeus.tools.deny '<json array>' --strict-json --replace`,
then `openclaw config validate`. Tool and binding changes hot-reload.

| Agent | Policy |
|---|---|
| `main` (Hermes) | No overrides. |
| `zeus` | Deny `google-calendar__*`, `group:automation`, `sessions_history`, `sessions_search` (he must not read other gods' conversations). Exec allowlist, empty. |
| `athena` | Deny `google-calendar__*`. Exec allowlist, empty. |
| `heracles`, `aphrodite`, `seneca` | `fs.workspaceOnly`, elevated off, exec allowlist = their own `remind*` wrappers. Deny `google-calendar__*`, `group:web`, `group:nodes`, `group:ui`, `group:automation` and every `group:sessions` member except `sessions_send`: `sessions`, `sessions_list`, `sessions_history`, `sessions_search`, `conversations_list`, `conversations_send`, `conversations_turn`, `sessions_spawn`, `sessions_yield`, `subagents`, `session_status`, `suggest_task`, `dismiss_task`. |

The `message` tool (`group:messaging`) is allowed for every god.

## Hand-off protocol

1. Every owner message reaches Zeus. He answers general matters himself.
2. For a specialist's craft he calls `sessions_send {sessionKey: "agent:<god>:main", message: <the owner's words verbatim, plus "File: <path>" lines>, timeoutSeconds: 0}` and ends his turn with exactly `NO_REPLY`.
3. The specialist sees `[Inter-session message] sourceSession=agent:zeus:main sourceTool=sessions_send isUser=false`, answers with `message {action: "send", channel: "telegram", target: "<OWNER_TG_ID>", message: …}` and ends with exactly `NO_REPLY`.
4. Word between gods (formerly `tell`) is a one-hop `sessions_send` carrying a fact. The receiver files it, acknowledges to the owner in one line with `message`, and ends with `NO_REPLY`.

Why the silent tokens matter: if a `sessions_send` target ends its turn with any
other text, OpenClaw runs up to five "ping-pong" turns between the two agents
(starting with the sender) plus an extra "announce" turn on the target.
`NO_REPLY`, `REPLY_SKIP`, `ANNOUNCE_SKIP` and `HEARTBEAT_OK` end that exchange;
Zeus answers any reply that bounces back to him with `REPLY_SKIP`. Pantheon's old
`/tell` loop guard and rate cap no longer exist — the persona rules plus this cap
replace them.

## Reminders

Gods schedule reminders by exec'ing small wrapper scripts:

```text
/home/openclaw/bin/remind-impl/            # the real scripts (remind, remind-in, …) + owner-chat
/home/openclaw/bin/remind*                 # the owner's wrappers  -> agent main (Hermes)
/home/openclaw/bin/agents/<agent-id>/remind*  # one agent's wrappers (gods, u_<id> users)
```

Each wrapper is two lines and pins the agent id:

```sh
#!/bin/sh
exec /home/openclaw/bin/remind-impl/remind-in heracles "$@"
```

**Why wrappers.** Attribution must not be derivable from anything the agent
controls. The working directory is not trustworthy (OpenClaw's exec tool honours a
caller-supplied `workdir`), and neither is the environment (agents may pass env
overrides). The only unforgeable primitive is OpenClaw's **per-agent exec
allowlist**: agent `heracles` may exec `/home/openclaw/bin/agents/heracles/remind*`
and nothing else. Because the wrapper hard-codes the id, an agent can only
schedule, list and cancel its own reminders. The implementations also set an
explicit `PATH` and validate the agent id, the job name (`[a-z0-9][a-z0-9-]{0,63}`)
and the timestamp or cron expression before calling `openclaw`.

| Command | Job |
|---|---|
| `remind <ISO-8601 timestamp> <name> <text>` | one-shot, deleted after a successful run |
| `remind-in <duration> <name> <text>` | one-shot, relative (`date -d "+<duration>"`) |
| `remind-cron "<5-field cron, UTC>" <name> <text>` | recurring |
| `remind-list` / `remind-rm <name>` | this agent's jobs only (name prefix `<agent>--`) |

Each job is `openclaw cron add --name=<agent>--<name> --agent=<agent> (--at|--cron)=…
--command-argv='["/bin/cat"]' --command-input=<text> --announce --channel=telegram
--to=<chat> [--delete-after-run]`: a command payload, so no model turn runs at fire
time and the text is delivered verbatim. A failed delivery marks the run failed.

The chat comes from the agent id: a `u_<digits>` agent delivers to `<digits>` (a
private chat's id is the user's id); every other agent is one of the owner's gods
and delivers to the numeric id in `/home/openclaw/bin/remind-impl/owner-chat`.
Write that file once, by hand: `echo <OWNER_TG_ID> > ~/bin/remind-impl/owner-chat`.

OpenClaw masks links and codes in a scheduled message on lines that read like
login prompts ("visit/open <link>", "log in at …", "verification code …"); give a
link on its own line without those words. Inspect jobs with `openclaw cron list`
and `openclaw cron runs --id <id>`.

## Morning standup

Seneca's morning letter starts on the owner's laptop, where the repositories are.
On weekdays at 09:30 (Asia/Novosibirsk) `seneca-standup.timer` runs
`laptop/seneca-standup`: the `daily-standup` skill's `collect.sh` (one day; three
on Mondays, back to Friday), then `claude -p --tools ""` with the skill's
`SKILL.md` as its rules — what `/daily-standup` does, headless. The summary goes
to the server over ssh:

```bash
ssh kz-openclaw /home/openclaw/bin/standup-intake <YYYY-MM-DD> < summary.md
```

`standup-intake` validates the date and the input (non-empty, at most 64 KiB),
stores `~/.openclaw/workspace-seneca/standups/<date>.md`, then runs one
`openclaw agent --agent seneca --deliver --reply-channel telegram --reply-to <owner chat>`
turn: Seneca's reply — the letter — goes to the owner. Exit codes: `0`
delivered, `2` bad input, `4` no workspace, `5` no owner chat, `6`
`openclaw agent` failed (the file is kept).

A failed step on the laptop raises a desktop notification that names it; the
details are in `journalctl --user -u seneca-standup`. `ssh` is retried only on its
own connection failure, so a laptop waking from sleep survives a late network.

Install on the laptop, once:

```bash
ln -sf ~/projects/pantheon/laptop/seneca-standup ~/.local/bin/seneca-standup
install -m 644 laptop/seneca-standup.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now seneca-standup.timer
systemctl --user list-timers seneca-standup.timer    # next weekday 09:30
systemctl --user start seneca-standup.service        # send one now
```

Tests: `bash laptop/seneca-standup.test.sh` → `OK` (stubs only, run on the laptop).

## Adding a god

```bash
openclaw agents add <id> --workspace ~/.openclaw/workspace-<id> --non-interactive
rm -f ~/.openclaw/workspace-<id>/BOOTSTRAP.md
```

1. Copy `gods/<id>/*` into the workspace, rendering `{{NAME}}`, `{{USERNAME}}`,
   `{{REMIND_BIN}}` (`/home/openclaw/bin/agents/<id>`) and `{{CHAT_ID}}` (the
   owner's Telegram id). On 2026.9.7 `openclaw doctor` folds `TOOLS.md` into
   `AGENTS.md` under `## Tools`; edit the live files in place from then on.
2. Set its tool policy (above).
3. `install-remind-wrappers <id> /home/openclaw/bin/agents/<id>` and
   `openclaw approvals allowlist add --agent <id> "/home/openclaw/bin/agents/<id>/remind*"`.
4. Add `<id>` to `tools.agentToAgent.allow`.
5. Add the god to Zeus's roster (`gods/zeus/` and Zeus's live `AGENTS.md`), and to
   the other gods' lists of kin.

## Adding a user

There is no self-provisioning. You need the user's numeric Telegram id.

```bash
ID=<telegram user id>; A=u_$ID
openclaw agents add $A --workspace ~/.openclaw/workspace-$A --non-interactive
rm -f ~/.openclaw/workspace-$A/BOOTSTRAP.md
```

1. Copy `workspace-template/*.md` into the workspace and render
   `workspace-template/*.md.tmpl` without the `.tmpl` suffix (`{{NAME}}`,
   `{{USERNAME}}`, `{{REMIND_BIN}}` = `/home/openclaw/bin/agents/$A`).
2. Tool policy:
   ```bash
   openclaw config set agents.entries.$A.tools '{"fs":{"workspaceOnly":true},"deny":["google-calendar__*","group:sessions","group:web","group:nodes","group:ui","group:automation"],"exec":{"mode":"allowlist"},"elevated":{"enabled":false}}' --strict-json --replace
   ```
3. `install-remind-wrappers $A /home/openclaw/bin/agents/$A` and
   `openclaw approvals allowlist add --agent $A "/home/openclaw/bin/agents/$A/remind*"`.
4. Append `{"agentId":"u_<ID>","match":{"channel":"telegram","peer":{"kind":"direct","id":"<ID>"}}}`
   to `bindings` (`config get bindings` → edit → `config set bindings … --strict-json --replace`).
5. Only then add `"<ID>"` to `channels.telegram.allowFrom`. An allowed user without
   a binding would reach the default agent — Hermes, the owner's own.

## Deploy

A push to `main` runs `.github/workflows/deploy.yml` over SSH as `openclaw`:
`git reset --hard origin/main` in `/opt/pantheon`, `bash bin/remind.test.sh` and
`bash bin/standup-intake.test.sh`, `docker rm -f pantheon` (the retired container
must never poll again), then install `bin/remind-impl/*`,
`bin/install-remind-wrappers` and `bin/standup-intake` into `/home/openclaw/bin`.
Files it does not ship (such as `owner-chat`) are left alone.

Persona files are not deployed: the gods write to their own workspaces, so the
live files are edited in place on the server, and `gods/` is kept in step by hand.

## Operations

```bash
openclaw channels status --probe       # telegram connected, one poller
openclaw agents list --bindings
openclaw cron list                     # add --all for disabled jobs
openclaw cron runs --id <job-id>       # delivery status per run
journalctl --user -u openclaw-gateway -f
```

## Known limits

- Pantheon's chat history did not carry over; sessions are now `agent:<id>:main`.
  Workspace memory files are unaffected.
- `/hermes`, `/athena`, `/gods` and `/auto` are gone: just tell Zeus what you want.
- A specialist's answer costs two model turns (Zeus + the god).
- Uploaded files stay in OpenClaw's media store (`~/.openclaw/media/inbound/`);
  Zeus passes their path. Gods with `fs.workspaceOnly` (Heracles, Aphrodite) cannot
  read them.
- OpenClaw does not echo a voice note's transcript back to the chat.

## Rollback to the old bot

Backups of the cutover are in `~/pantheon-migration-backup-20261006-104233`
(`openclaw.json`, `~/bin`, persona files, cron and approvals JSON). Restore
`openclaw.json` (removes `channels.telegram`) and `openclaw gateway restart`;
restore `~/bin` and the persona files; then
`cd /opt/pantheon && git checkout pantheon-last-container && docker compose up -d --build`.
The two weekly reminders would need their old `/notify` payload back (see
`cron.json` in the backup).

## Gods

### Zeus — the door

`gods/zeus/` answers general questions himself (web search via keyless
endpoints) and hands every specialist matter to the right god.

### Athena — the vacancy hunt

`gods/athena/` is the job-hunt god. She is web-enabled (Greenhouse/Lever/Ashby
boards, Remotive, RemoteOK, We Work Remotely, HN "Who's Hiring") and configured
entirely by conversation: tell her what you're hunting and send your résumé; she
records its path and finds, ranks and tailors on request. Auto-submission is
deliberately not built.

### Heracles — goals & habits

`gods/heracles/` breaks a declared goal into 3–7 labors, keeps the ledger in his
`MEMORY.md`, and holds you to the work. With your consent he schedules check-ins
through the reminder helpers. He is not web-enabled and holds no calendar.

### Aphrodite — matters of the heart

`gods/aphrodite/` keeps a private ledger of the people who matter, turns it into
gift ideas and drafted messages, and counsels through conflict. She never
contacts anyone: she drafts, you send. With consent she schedules preparation and
stay-in-touch nudges. Her ledger is the most sensitive data in the pantheon —
workspace-only fs, exec allowlist only.

### Seneca — the counsel for work

`gods/seneca/` is no god: the one mortal at the court, a Stoic who keeps the
owner's work at Synecta. Every weekday morning he turns the laptop's standup into
a short letter — the summary verbatim — and he answers questions about the work
from his `standups/` record. On request he keeps work reminders through his own
wrappers. No web, no GitLab, no Jira: he knows what the laptop sends and what he
is told. See [Morning standup](#morning-standup).

[OpenClaw]: https://docs.openclaw.ai
