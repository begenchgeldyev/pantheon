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

Observed on 2026-11-12 (OpenClaw 2026.10.10): the configured household is
**Hermes (`main`), Zeus (`zeus`) and Seneca (`seneca`)**. Athena, Heracles and
Aphrodite are parked templates with retained history, not live handoff targets.
Template directories are not runtime configuration; consult configured agents
(`openclaw agents list --bindings`), not directory enumeration, for any future selector.
Editing these templates does not change live workspaces.

```text
Telegram (owner) ──► OpenClaw channels.telegram ── binding ──► zeus (agent:zeus:main)
                                                                   │ sessions_send
                                                                   ▼
Telegram ◄── message tool ── specialist (agent:main:main = Hermes, agent:seneca:main)

Reminders: god ──exec its own wrapper──► bin/remind-impl ──► openclaw cron add
           (command job: /bin/cat <text>) ──► OpenClaw announces stdout ──► Telegram

Standup:   laptop timer ── laptop/seneca-standup (collect.sh → opencode run sol) ──ssh──► bin/standup-intake
           ──► standups/<date>.md + openclaw agent --agent seneca --deliver ──► Telegram
```

Only the owner has a pantheon. A non-owner user would get one isolated `u_<id>`
agent bound to their own chat (see [Adding a user](#adding-a-user)).

| Path | What it is |
|---|---|
| `GLOSSARY.md` | Household vocabulary — the canonical names for gods, hand-offs, standup, monitor and state. |
| `docs/adr/` | One-paragraph records of decisions that are hard to reverse, with the rejected alternative named. |
| `gods/<id>/` | Active Zeus/Seneca templates and parked Athena/Heracles/Aphrodite templates (`{{NAME}}`, `{{USERNAME}}`, `{{REMIND_BIN}}`, `{{CHAT_ID}}`); Hermes is configured as `main`, with no dedicated `gods/main/` here. |
| `workspace-template/` | Persona template for a non-owner user's own agent (Hermes-style). |
| `bin/remind-impl/` | The real `remind*` helpers; they take the agent id as their first argument. |
| `bin/install-remind-wrappers` | Writes an agent's wrapper scripts (agent id baked in). |
| `bin/remind.test.sh` | Tests for the helpers: `bash bin/remind.test.sh` → `OK`. |
| `bin/standup-intake` | Receives the morning standup from the laptop and has Seneca deliver it. |
| `bin/standup-intake.test.sh` | Its tests: `bash bin/standup-intake.test.sh` → `OK`. |
| `bin/pantheon-state`, `bin/pantheon_ops/` | Shared durable lifecycle helper/package; required adjacent on laptop and server. |
| `bin/pantheon-status`, `bin/pantheon-check` | Read-only reliability report and separately activated non-model alert checker. |
| `bin/install-pantheon-helpers` | Explicit-destination passive server/laptop/plugin packaging; isolated fixture in `bin/install-pantheon-helpers.test.sh`. |
| `server/` | Passive monitor user service/timer templates, not enabled by installation. |
| `laptop/` | The laptop half of the standup: `seneca-standup`, its systemd user units, its tests. |
| `.github/workflows/deploy.yml` | Deploys the helpers to the server on push to `main`. |

The vocabulary used below is defined in [GLOSSARY.md](GLOSSARY.md); decisions that would surprise a reader are recorded in [docs/adr/](docs/adr/).

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
the gateway log. The following is a setup example, not a snapshot of live policy.

```bash
openclaw config set channels.telegram '{"tokenFile":"/home/openclaw/.openclaw/telegram-bot-token","dmPolicy":"allowlist","allowFrom":["<OWNER_TG_ID>"],"groupPolicy":"allowlist"}' --strict-json
openclaw config set bindings '[{"agentId":"zeus","match":{"channel":"telegram","peer":{"kind":"direct","id":"<OWNER_TG_ID>"}}}]' --strict-json --replace
openclaw agents list --bindings     # zeus ← telegram direct <OWNER_TG_ID>
```

`allowFrom` takes numeric Telegram user ids, not usernames. `groupPolicy: "allowlist"`
is not a universal group-blocking guarantee: group/sender entries also matter.
The 2026-11-12 audit observed a configured group with wildcard sender allowance
and no mention requirement; full admission behavior was not tested. Inspect all
group settings before relying on this example as an admission policy.
Per-chat bindings go through `config set bindings`; `openclaw agents bind` only
binds whole channels.

### 3. Agent-to-agent

```bash
openclaw config set tools.agentToAgent '{"enabled":true,"allow":["zeus","main","seneca"]}' --strict-json
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
| `seneca` | `fs.workspaceOnly`, elevated off, exec allowlist = his own `remind*` wrappers. Deny `google-calendar__*`, `group:web`, `group:nodes`, `group:ui`, `group:automation` and every `group:sessions` member except `sessions_send`: `sessions`, `sessions_list`, `sessions_history`, `sessions_search`, `conversations_list`, `conversations_send`, `conversations_turn`, `sessions_spawn`, `sessions_yield`, `subagents`, `session_status`, `suggest_task`, `dismiss_task`. |

These are setup policies for the active roster, not activation instructions for
parked templates. The `message` tool (`group:messaging`) is allowed for the active gods.

## Hand-off protocol

1. Every owner message reaches Zeus. He answers general matters himself.
2. For Hermes (`main`: personal dates/reminders) or Seneca (`seneca`: Synecta work), he calls `sessions_send {sessionKey: "agent:<god>:main", message: <the owner's words verbatim, plus "File: <path>" lines>, timeoutSeconds: 0}`. After a non-error submission he ends with exactly `NO_REPLY`; this does not prove processing or delivery. Errors/uncertain outcomes get a truthful normal reply, not silent success or a blind resend. Parked crafts stay with Zeus within his tools; explicit requests for parked gods get an explanation that they are unavailable.
3. The specialist sees `[Inter-session message] sourceSession=agent:zeus:main sourceTool=sessions_send isUser=false`, answers with minimal `message {action: "send", channel: "telegram", target: "<OWNER_TG_ID>", message: …}` and ends with exactly `NO_REPLY` after a non-error send. Repair named fields on deterministic validation errors before another call; never retry unchanged invalid arguments. Other failed/uncertain sends get an honest error report, not a delivery claim or unconditional retry.
4. Word between active specialists (formerly `tell`) is a one-hop `sessions_send` carrying an explicitly requested fact. The receiver files it, acknowledges to the owner in one line with the same explicit Telegram route, and follows the same success/error branches. No handoffs to parked gods.

Action-specific arguments omit unrelated optional defaults: a poll uses at most
one duration unit; a location uses valid coordinates without unrelated text/media;
Telegram cards (`clawhub`) are omitted. Prompt guidance supplements, not replaces,
the separately activated [message guard](plugins/pantheon-message-guard/README.md).
Its explicit-channel send/poll policy is not the whole host schema, does not certify
inferred routes, and does not itself stop a run immediately. Native enforcement
and loop integration remain approval-gated harness checks.

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
exec /home/openclaw/bin/remind-impl/remind-in seneca "$@"
```

**Why wrappers.** Attribution must not be derivable from anything the agent
controls. The working directory is not trustworthy (OpenClaw's exec tool honours a
caller-supplied `workdir`), and neither is the environment (agents may pass env
overrides). The only unforgeable primitive is OpenClaw's **per-agent exec
allowlist**: agent `seneca` may exec `/home/openclaw/bin/agents/seneca/remind*`
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
Provision that numeric file deliberately during approved setup; the passive
installer never creates or overwrites it. Monitoring additionally requires the
protected ownership/mode contract below.

OpenClaw masks links and codes in a scheduled message on lines that read like
login prompts ("visit/open <link>", "log in at …", "verification code …"); give a
link on its own line without those words. Inspect jobs with `openclaw cron list`
and `openclaw cron runs --id <id>`.

## Morning standup

Seneca's standup starts on the owner's laptop, where the repositories are.
On weekdays at 07:00 (Asia/Tomsk) `seneca-standup.timer` runs
`laptop/seneca-standup`: the `daily-standup` skill's `collect.sh` (one day; three
on Mondays, back to Friday), then `opencode run --model proxy/gpt-6.1-sol` with the
skill's `SKILL.md` as its rules — what `/daily-standup` does, headless. The
summary goes to the server over ssh:

```bash
ssh server /home/openclaw/bin/standup-intake <YYYY-MM-DD> < summary.md
```

`standup-intake` validates a real calendar date and non-empty input up to 64 KiB,
stores `~/.openclaw/workspace-seneca/standups/<date>.md` (0600), and records an
attempt before invoking `openclaw agent --agent seneca --deliver --reply-channel
telegram --reply-to <owner chat>`. Seneca replies only with the complete,
formatting-only Markdown summary; automatic delivery is requested, not presumed.
Processing and delivery are independent receipt fields. Exit `0` alone proves
neither; inspect the receipt. Exit `2` covers invalid input/state, `4` missing
workspace/runuser, `5` owner-chat lookup failure, `6` native nonzero exit (also
replayed for a recorded native failure). Stored input survives native failure.

Inspect a single server receipt without submitting anything:
`~/bin/pantheon-state status YYYY-MM-DD --workspace ~/.openclaw/workspace-seneca`.
An optional leading `--state-dir PATH` overrides its state directory; missing
input prints `null`, while legacy discovery reports stored-only evidence.

Server state defaults to `/home/openclaw/.local/state/pantheon` (override
`PANTHEON_STATE_DIR`); per-date `standups/DATE/state.json` records hashes, attempt
identity, actual UTC times and safe stage/error evidence, not summary text or
destinations. Directories are 0700, receipt/lock files 0600. The intake retains
root-to-openclaw runuser/ownership handling; the monitor must run as the runtime
user, not root. A legacy summary without metadata proves **stored only**.

Same-date/same-hash input replays recorded state without another Seneca turn.
Changed content requires both `--replace --resend`; an uncertain/interrupted
attempt is never automatically resent. `--resume` reuses stored input, not
recollection. Explicit resend creates a new attempt and may duplicate prior work:

```bash
# Operator recovery examples ONLY after reviewing the recorded outcome:
ssh server /home/openclaw/bin/standup-intake YYYY-MM-DD --resume
ssh server /home/openclaw/bin/standup-intake YYYY-MM-DD --resume --resend
ssh server /home/openclaw/bin/standup-intake YYYY-MM-DD --replace --resend < revised-summary.md
```

A failed step on the laptop raises a desktop notification that names it; the
details are in `journalctl --user -u seneca-standup`. SSH255 is an **unknown**
submission outcome, including possible remote acceptance; there is no automatic
SSH retry. `SENECA_SSH_RETRIES/BACKOFF` no longer control retries.

Laptop state defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/pantheon`
(`SENECA_STATE_DIR` override), with protected summary/diagnostics in each date
directory. The helper is `$HOME/.local/bin/pantheon-state` (`SENECA_STATE_HELPER`
override), with adjacent `pantheon_ops/{__init__.py,state.py}` required. A default
rerun with a saved summary only shows its record. `--resume` submits that saved
summary through the server duplicate gate without generation; `--resend` explicitly
requests remote redispatch and warns. Logical dates use Asia/Tomsk; actual
collection time/window remains explicit, so a backdated label is not a backfill.

Passive laptop copy, from this checkout (no timer activation):

```bash
bash bin/install-pantheon-helpers laptop "$HOME/.local/bin" "$HOME/.config/systemd/user"
SENECA_DATE=2026-11-12 ~/.local/bin/seneca-standup --status  # read-only; no SSH/model
```

After separate live approval, verify collector/skill paths, `server` SSH access,
runtime PATH and `proxy/gpt-6.1-sol`, then run user `daemon-reload` and
`enable --now seneca-standup.timer`. The timer is weekdays 07:00 Asia/Tomsk.
Starting `seneca-standup.service` or running a fresh standup is **not a harmless
check**: it invokes a real model and can send to Telegram. Recovery `--resume` and
`--resend` also require deliberate operator action. Rollback: stop/disable the
timer and stop the service; retain protected local/server receipts for dedupe.

Tests: `bash laptop/seneca-standup.test.sh` (stubs only).

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

A push to `main` runs `.github/workflows/deploy.yml`: hosted Python/Bun/Bash
fixtures and shell checks, then existing SSH checkout/deploy as `openclaw` in
`/opt/pantheon`, local stub suites and removal of the retired container (which must
never poll again). `install-pantheon-helpers server /home/openclaw/bin
/home/openclaw/.config/systemd/user` copies only these production files:

- executables (0755): `standup-intake`, `pantheon-state`, `pantheon-status`,
  `pantheon-check`, `install-remind-wrappers`, and the five existing
  `remind-impl/{remind,remind-in,remind-cron,remind-list,remind-rm}` helpers;
- modules (0644), adjacent to the wrappers:
  `pantheon_ops/{__init__.py,state.py,native.py,monitor.py}`, plus
  `remind-impl/remind-lib` (0644);
- passive user units (0644): `pantheon-check.service` and `pantheon-check.timer`.

Every installer destination is explicit; all required source files are checked
before copying begins. It does not copy tests/fixtures/private notes, alter existing
per-agent wrappers, create/overwrite owner-chat, initialize state/baseline, reload
or enable units, invoke native commands, activate a plugin or send anything.
Source preflight is not a transactional rollback on a later filesystem error.
Python >=3.10 with stdlib zoneinfo and Asia/Tomsk tzdata is required, without pip/SDK
dependencies. Read-only server evidence observed Python 3.12.3. Existing reminder
runtime dependencies (`jq`, `column`) remain. The installer copies user units
unchanged, preserving their runtime executable and PATH; it does not install or
relocate OpenClaw or Node.

The plugin is a separate passive package, not part of server helper activation:
`bash bin/install-pantheon-helpers plugin /absolute/protected/pantheon-message-guard`
copies only `index.ts`, `validator.ts`, `package.json`, `openclaw.plugin.json` and
its README (0644). It does not run native plugin installation or an SDK install.
Obtain approval and pass the isolated native hook/loop harness first, then follow
the plugin README for local-directory installation, explicit enable/trust review,
controlled Gateway reload and verification. Rollback disables the plugin,
restores prior trust/load config and performs the controlled reload; removing
enforcement is not equivalent to retaining prompt guidance.

Persona files are not deployed: the gods write to their own workspaces, so the
live files are edited in place on the server, and `gods/` is kept in step by hand.

## Reliability status and alerts

`pantheon-status` is read-only (including before initialization): configured
agents, supported native cron processing/delivery reads, standup stages, source
timestamps/gaps and monitor/alert health. It does not collect, invoke models,
send, SSH or create state. `pantheon-check` can send non-model owner-only failure
alerts; use it only under approved activation. Both accept `--json` and:

```text
--state-dir PATH          --workspace PATH
--owner-chat-file PATH    --native-executable PATH
--timeout SECONDS         --page-size N         --max-pages N
--exclude-date YYYY-MM-DD (repeatable)          --pause-until YYYY-MM-DD
--since YYYY-MM-DD        --until YYYY-MM-DD
```

Path environment defaults are `PANTHEON_STATE_DIR`, `PANTHEON_WORKSPACE`,
`PANTHEON_OWNER_CHAT_FILE`, `PANTHEON_NATIVE_EXECUTABLE`; flags override them.
Native executable is one pathname, not a shell command. Defaults: 10s timeout,
50 rows/page, 5 pages; gaps/unavailable sources stay visible rather than claiming
complete history. Status before baseline shows `initialized=false`. Exit 0 means
the observation/check completed without detected source/gap/alert-health problems,
not end-to-end delivery; exit 2 includes invalid/unavailable state/config/sources,
gaps, uninitialized checker or unresolved alert outcomes.

### Bounded dated coverage and correlation

`--since` and `--until` select an inclusive reporting range of at most 366 days:

```bash
~/bin/pantheon-status --since 2026-11-01 --until 2026-11-12
~/bin/pantheon-status --json --since 2026-11-01 --until 2026-11-12
```

Without range flags, initialized reports cover activation through today in
Asia/Tomsk; uninitialized reports cover today only. If that entirely default
initialized range exceeds 366 days, the latest 366 are shown with explicit
`range_truncated`/`omitted_range`, original requested bounds and exit 2. Explicit
ranges must be valid calendar dates, ordered and at most 366 days; invalid ranges
are rejected before native reads, not silently shortened. An omitted start uses
activation/today, an omitted end uses today; an earlier end needs an explicit
start. Future dates are reportable but not prematurely due. There are no date-range
environment variables. Checker range flags affect reporting only: standup alerts
evaluate **today only**, never backfill historical dates.

Each dated row separates monitoring/expectation, input storage, processing and
delivery. Pre-activation dates (or unknown activation) have unknown expected/due
values, not invented missed standups; observed records still appear. Legacy files
count as received/stored-only with unknown processing/delivery, not sent. Counts
for received/status describe all observed rows, including unmonitored dates;
expected/due/missing counts use only known monitored expectations. Malformed or
unreadable state is unavailable/unknown, not proven missing. Individual delivery
states retain failed/partial/suppressed distinctions even though the aggregate
`delivery_failed` count groups them. Processing success with unknown delivery is
not settled or a successful send: it stays pending for later evidence. Explicit
processing, delivery or completion failure can settle independently of other
unknown dimensions; a later proven failure remains alertable once.

Coverage applies **current policy**, including today's configured exclusions and
inclusive pause, to past dates. It is labeled a current-policy assumption, not a
reconstructed maintenance history. Check dated rows and coverage gaps as well as
counts; retention limits do not establish complete native history.

Dated retained native-history rows show independent processing/delivery/completion,
wire observation time, baseline/start context and a safe `run-<12 hex>` reference.
That reference matches the native-failure alert and `monitor.alert_evidence`, even
when a public run ID appears later. Standup rows and their alerts similarly share
`standup-<12 hex>` references. Alert evidence includes date, coarse failure dimension,
outcome and retry/error context; source poll time is separate from wire observation
time. Match these references to investigate an alert without exposing private
summaries, destinations or raw diagnostics. A retained failure is history, not a
claim of a current provider outage.

For uncertain sends or inconsistent evidence, preserve protected receipts/ledger,
inspect matching dated references and source gaps, and reconcile with separately
approved read-only native/provider evidence before deciding any explicit resend.
Do not delete state, reinitialize baseline or blindly retry as a repair. Earlier
incorrectly retired snapshots would need operator provenance review **only if an
earlier implementation had actually been deployed**; none was deployed here.
No damaged production state is inferred from these local corrections.

Baseline initialization snapshots completed native history **without backlog
alerts**, preserving already-in-flight identities for subsequent failures.
Expected standup coverage starts on initialization in Asia/Tomsk, weekdays 07:00:
missing input alerts at 07:30; stored but incomplete alerts at 07:45 or 15 minutes
after storage, whichever is later. Explicit failed processing or failed/partial/
suppressed expected standup delivery is immediately alertable. Pauses (inclusive
until date) and excluded dates affect standup expectations, not independently
proven new native failures; there is no automatic holiday calendar. Ordinary cron
suppression/no-delivery-required and expected empty-heartbeat skips are informational
unless independently failed. Historical failures are not current provider downtime.

Alerts are bounded, deduplicated plain text using existing System Agent credentials,
not agent/model turns. No token is copied, no `--agent` flag is used. Dispatch intent
is persisted before sending, at most five dispatches/check; only proven pre-spawn
failures retry (at most three total, 60s then 120s minimum backoff). Unknown, queued,
partial, suppressed or post-spawn failure needs operator reconciliation, not blind
resend. Alert failures remain local in protected monitor state/status, never
recursively alert. There is no recovery notification, exactly-once crash guarantee
or recipient display/read guarantee. Sent means platform-send acknowledgement;
cron/native projection and direct-send provider-ID evidence are distinct.

### Separately approved monitor activation (not performed by CI)

1. Back up configuration and protected state; verify native CLI compatibility as
   the runtime `openclaw` user. Read-only evidence confirms executable paths
   `/home/openclaw/.openclaw/tools/node/bin/openclaw` and the adjacent `node`;
   `/home/openclaw/.local/bin/openclaw` does **not** exist on the observed server.
   Use the stable tools/node/bin OpenClaw path and prepend that directory to PATH
   so its bundled Node resolves. This is path evidence, not a native execution or
   activation check. On a different host, set `PANTHEON_NATIVE_EXECUTABLE` and,
   if needed, PATH in `~/.config/pantheon/monitor.env` before enabling. This optional
   environment file can override the four path variables above. Keep configuration
   protected and use the same executable/PATH for manual checks.
2. Passively copy server helpers/modules and **user** units as above. Deliberately
   prepare `/home/openclaw/.local/state/pantheon` owned by `openclaw`, mode 0700
   (monitor directory 0700 and files 0600). Run the checker as that same user,
   **not root** against another user's state. During approved deployment inspect
   the existing numeric owner-chat file: it must be a non-symlink regular file
   owned by the runtime user with no group/other access (0600). Deliberately correct
   ownership/mode if needed; do not fabricate or overwrite the existing destination.
3. As `openclaw`, with the same environment as the unit, inspect
   `~/bin/pantheon-status --json`; resolve unavailable sources/gaps. Then explicitly
   run `~/bin/pantheon-check --initialize --json` **once** (requires complete sources,
   sends no backlog). Repeated initialization refuses to reset dedupe. Starting
   the checker service is not a substitute for initialization.
4. Only after inspection, run `systemctl --user daemon-reload` and
   `systemctl --user enable --now pantheon-check.timer`. This starts five-minute
   checks (`Persistent=false`), which may send real failure alerts. For pauses,
   exclusions or paging bounds, use a user service drop-in replacing `ExecStart`
   with `~/bin/pantheon-check`'s absolute path and the flags above; mirror those
   flags when manually inspecting status/checks. Increased scan bounds may require
   raising the service's 180-second timeout. No automatic activation happens here.

Rollback: stop/disable `pantheon-check.timer` and stop `pantheon-check.service`.
Retain protected monitor state (including uncertain dispatches, baseline and
dedupe) and standup receipts. Deleting state is not a safe reset/retry procedure.
Keep status available for reconciliation; restore prior binaries/configuration
only with a compatible state format. Native scheduling, ownership, hook loading
and real send acceptance still require separately approved validation.

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
  Zeus passes their path. An agent with `fs.workspaceOnly` (Seneca in the setup
  policy above) cannot read files outside its workspace.
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

### Hermes — dates & reminders (active as `main`)

The owner's configured `main` agent keeps personal dates and reminders. There is
no dedicated Hermes persona directory here; `workspace-template/` is for non-owner
users, not a copy of the owner's live workspace.

### Zeus — the door

`gods/zeus/` answers general questions himself (web search via keyless
endpoints) and hands every specialist matter to the right god.

### Athena — the vacancy hunt (parked template/history)

The retained `gods/athena/` template describes the job-hunt god, not a configured
recipient. Its historical capabilities were web-enabled (Greenhouse/Lever/Ashby
boards, Remotive, RemoteOK, We Work Remotely, HN "Who's Hiring") and configured
by conversation, recording a résumé path and finding, ranking and tailoring on
request. Auto-submission was deliberately not built. This is a template capability
description, not an instruction to contact a live Athena.

### Heracles — goals & habits (parked template/history)

`gods/heracles/` breaks a declared goal into 3–7 labors, keeps the ledger in his
`MEMORY.md`, and holds you to the work. With your consent he schedules check-ins
through the reminder helpers. He is not web-enabled and holds no calendar.

### Aphrodite — matters of the heart (parked template/history)

`gods/aphrodite/` keeps a private ledger of the people who matter, turns it into
gift ideas and drafted messages, and counsels through conflict. She never
contacts anyone: she drafts, you send. With consent she schedules preparation and
stay-in-touch nudges. Her ledger is the most sensitive data in the pantheon —
workspace-only fs, exec allowlist only.

### Seneca — the counsel for work

`gods/seneca/` is no god: the one mortal at the court, a Stoic who keeps the
owner's work at Synecta. Every weekday morning he formats the laptop's complete
summary for Telegram, preserving every fact, warning, status and reporting window;
he adds no letter, philosophy, greeting or signature. The exact formatting-only
protocol is in `gods/seneca/AGENTS.md`: a normal Markdown reply, automatic intake
delivery, no `message` tool, no `NO_REPLY`, and no writes to the standup or memory.
In ordinary conversation he answers questions about the work
from his `standups/` record. On request he keeps work reminders through his own
wrappers. No web, no GitLab, no Jira: he knows what the laptop sends and what he
is told. See [Morning standup](#morning-standup).

[OpenClaw]: https://docs.openclaw.ai
