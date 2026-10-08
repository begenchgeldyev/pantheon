# Seneca — the owner's counsel for work at Synecta

Status: approved 2026-10-08 (design reviewed section by section in chat); not yet
implemented.

Seneca (Lucius Annaeus Seneca, Seneca the Younger) joins the pantheon as the one
mortal at its court: a Stoic counsellor who keeps the owner's work at Synecta.
His first duty is the morning standup. A job on the owner's laptop runs the
`/daily-standup` skill on schedule and hands the finished summary to the server;
Seneca delivers it to Telegram as a short letter. He also answers questions about
the owner's work and keeps work reminders.

## Decisions

1. **Seneca is an owner specialist like the gods.** Agent id `seneca`, workspace
   `~/.openclaw/workspace-seneca`, the default model. Reached only through Zeus
   (`sessions_send` into `agent:seneca:main`); he replies with the `message` tool
   and ends with `NO_REPLY`. No bot or binding of his own.
2. **The data comes from the laptop.** The server cannot see the owner's
   repositories: it has no GitLab key, and uncommitted work and unpushed branches
   exist only on the laptop. The server never holds Synecta credentials or source.
3. **The laptop sends the finished summary, not raw data.** The job runs what
   `/daily-standup` runs — `collect.sh`, then an LLM with the skill's own rules
   (`SKILL.md`) — headless (`claude -p --tools ""`). Seneca does not rewrite it.
4. **The "endpoint" is an SSH-invoked intake, not HTTP.** The gateway binds
   loopback and OpenClaw's HTTP hooks are off; an HTTP route would need an SSH
   tunnel anyway, or public exposure plus a hook token. The laptop's SSH key for
   `openclaw@kz-openclaw` already exists:
   `ssh kz-openclaw /home/openclaw/bin/standup-intake <date> < summary.md`.
5. **The intake stores, then hands the letter to Seneca.** It writes
   `standups/<date>.md` in Seneca's workspace atomically, then runs
   `openclaw agent --agent seneca --message-file <msg> --deliver
   --reply-channel telegram --reply-to <owner chat>`: one turn in Seneca's main
   session whose reply OpenClaw delivers to the owner's chat (Markdown converted
   to Telegram HTML, split above 4000 characters). Its exit status tells the
   laptop whether delivery happened.
6. **The standup is a letter; the summary is verbatim.** Seneca frames it — one
   greeting line in the manner of the Letters to Lucilius, the summary unchanged,
   one thought for the day tied to the work, `Vale.` — and never edits, reorders,
   shortens or adds to the summary. A day without commits still gets a short,
   honest letter, which also shows the pipeline is alive.
7. **The schedule lives on the laptop.** A systemd user timer, Monday–Friday at
   09:30 local time (Asia/Novosibirsk), `Persistent=true` so a sleeping laptop
   catches up on wake. Window: `3d` on Mondays (from Friday 09:30), `1d`
   otherwise.
8. **Failures surface on the laptop.** Any failed step — collect, LLM, empty
   summary, SSH, intake, delivery — raises a desktop notification naming the
   step; details go to `journalctl --user -u seneca-standup`. The intake rejects
   bad input before it touches OpenClaw.
9. **Work reminders go through Seneca's own wrappers**, exactly as Heracles's
   check-ins do: `/home/openclaw/bin/agents/seneca/remind*`, with the per-agent
   exec allowlist pinned to them. Personal dates stay Hermes's.
10. **Seneca's tool policy matches Heracles's**: `fs.workspaceOnly`, elevated off,
    exec allowlist (his remind wrappers only), deny `google-calendar__*`,
    `group:web`, `group:nodes`, `group:ui`, `group:automation` and every
    `group:sessions` member except `sessions_send`.

## Flow

```text
laptop — systemd user timer, Mon–Fri 09:30 Asia/Novosibirsk
  seneca-standup: collect.sh <1d|3d> ─► claude -p (SKILL.md rules, no tools) ─► summary
    └─ ssh kz-openclaw /home/openclaw/bin/standup-intake <YYYY-MM-DD>  (summary on stdin)

server — openclaw@kz-openclaw
  standup-intake: validate ─► ~/.openclaw/workspace-seneca/standups/<YYYY-MM-DD>.md
    └─ openclaw agent --agent seneca --message-file … --deliver
                      --reply-channel telegram --reply-to <owner chat>
         └─ agent:seneca:main replies with the letter ─► Telegram (owner)

questions and work reminders
  owner ─► Telegram ─► zeus ── sessions_send ──► agent:seneca:main ── message ──► Telegram
```

## Components

| Path | What it is |
|---|---|
| `gods/seneca/` | Persona: AGENTS, SOUL, IDENTITY, USER, TOOLS, HEARTBEAT, MEMORY — Heracles's skeleton; placeholders `{{NAME}}`, `{{USERNAME}}`, `{{CHAT_ID}}`, `{{REMIND_BIN}}`. |
| `gods/zeus/`, `gods/{athena,heracles,aphrodite}/TOOLS.md` | Zeus's roster and hand-off list, the gods' kin lists, now naming Seneca. |
| `bin/standup-intake` | The server intake (contract below). |
| `bin/standup-intake.test.sh` | Stub-`openclaw` tests in the style of `bin/remind.test.sh`. |
| `laptop/seneca-standup` | The laptop job (contract below). |
| `laptop/seneca-standup.service`, `laptop/seneca-standup.timer` | systemd user units. |
| `laptop/seneca-standup.test.sh` | Stub tests for the job; run on the laptop. |
| `.github/workflows/deploy.yml` | Also installs `standup-intake` and runs its tests. |
| `README.md` | Seneca in the gods list, tool policies, `agentToAgent`, deploy, laptop setup. |

### Intake contract — `bin/standup-intake <YYYY-MM-DD>`, summary on stdin

- Sources `remind-impl/remind-lib` next to it: pinned `PATH`, and the owner chat
  from `owner-chat` (`pantheon_chat_for_agent seneca`).
- Constants at the top (tests rewrite them on a live copy, as `remind.test.sh`
  does for `PATH`): the workspace `/home/openclaw/.openclaw/workspace-seneca`.
- Validates before anything else: one argument, `^[0-9]{4}-[0-9]{2}-[0-9]{2}$`
  and a real calendar date; stdin non-empty and at most 64 KiB.
- Writes `standups/<date>.md` atomically (temp file in the same directory, then
  `mv`); a rerun for the same date replaces it.
- Builds the message to Seneca — first line `[standup <date>]`, one line naming
  the file and the task, then the summary between `<<<SUMMARY` and `SUMMARY>>>`
  — and runs `openclaw agent --agent seneca --message-file <tmp> --deliver
  --reply-channel telegram --reply-to <chat> --timeout 300 --json`.
- Exit codes: `0` delivered (prints `delivered <date>`); `2` usage, bad date,
  empty or oversized input — nothing stored, nothing sent; `4` Seneca's workspace
  missing; `5` owner chat not configured (from `remind-lib`); `6` `openclaw agent`
  failed — the file stays, the letter did not go.

### Laptop job contract — `laptop/seneca-standup`

- Overridable for tests through the environment: `SENECA_COLLECT` (default
  `~/.claude/skills/daily-standup/scripts/collect.sh`), `SENECA_SKILL` (default
  `~/.claude/skills/daily-standup/SKILL.md`), `SENECA_HOST` (`kz-openclaw`),
  `SENECA_INTAKE` (`/home/openclaw/bin/standup-intake`), `SENECA_CLAUDE`
  (`claude`), `SENECA_NOTIFY` (`notify-send`), `SENECA_DATE` (default today).
- Window `3d` when the date is a Monday, else `1d`.
- `claude -p --tools "" --strict-mcp-config --no-session-persistence`, prompt on
  stdin: an automated-run preamble (the data is already collected; output only
  the summary, no questions or offers), the skill's `SKILL.md`, then the
  `collect.sh` output.
- Stops at the first failed step — collect, claude, empty summary, ssh/intake —
  with a notification `Сенека: стендап не отправлен — <step>` and a non-zero
  exit; nothing is sent after a failure.
- Units: `Type=oneshot`, `ExecStart=%h/.local/bin/seneca-standup`; timer
  `OnCalendar=Mon..Fri *-*-* 09:30:00`, `Persistent=true`. Installed by
  symlinking the script into `~/.local/bin` and copying the units into
  `~/.config/systemd/user`.

## Persona outline (`gods/seneca/`)

- **IDENTITY:** Seneca 📜 — Stoic philosopher, tutor and counsellor to Nero,
  author of the Letters to Lucilius; the one mortal at the pantheon's court,
  admitted as counsel for work, not as a god. Vibe: calm, lucid, frank, kind.
- **SOUL:** time is the only thing truly ours (*On the Shortness of Life*);
  separate what is in our power from what is not; the facts of the work plainly
  and in full; never invent work the data does not show; one or two Stoic touches
  per reply, never a wall of maxims; reply in the language the mortal writes in.
- **AGENTS:** the charge — the morning letter (protocol of decision 6), answers
  about the work from `standups/` and `MEMORY.md`, work reminders. Boundaries:
  personal dates are Hermes's; no GitLab, no Jira, no web — he knows what the
  laptop sends and what the mortal tells him.
- **TOOLS:** the mortal's chat (`message` to `{{CHAT_ID}}`, then `NO_REPLY`); the
  morning letter as a plain reply (no `message` tool, no `NO_REPLY`); the remind
  helpers; word to kin.
- **USER:** name, username, chat id; timezone Asia/Novosibirsk; works at Synecta
  on rz-web-client, rz-web-server, device-sdk and spectra; Jira keys `PNRMN-…`.
- **HEARTBEAT:** comments only (no heartbeat calls). **MEMORY:** the work ledger.

## Server rollout (after the deploy)

1. Back up every file this touches into `~/seneca-rollout-backup-<timestamp>/`:
   `openclaw.json`, Zeus's live `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and the
   live `AGENTS.md` of `main`, `athena`, `heracles`, `aphrodite`.
2. `openclaw agents add seneca --workspace ~/.openclaw/workspace-seneca
   --non-interactive`; remove its `BOOTSTRAP.md`.
3. Render `gods/seneca/*` into the workspace; create `standups/`.
4. Set `agents.entries.seneca.tools` (decision 10); `openclaw config validate`.
5. `install-remind-wrappers seneca /home/openclaw/bin/agents/seneca`;
   `openclaw approvals allowlist add --agent seneca
   "/home/openclaw/bin/agents/seneca/remind*"`.
6. Add `seneca` to `tools.agentToAgent.allow`.
7. Edit the live files in place: Zeus's roster, hand-off list and "What you do
   not hold"; his IDENTITY and SOUL; the kin lines of Hermes, Athena, Heracles
   and Aphrodite.

## Acceptance

- **S1** `openclaw agents list` shows `seneca` with its workspace; a message to
  Zeus asking who Seneca is, sent with `openclaw agent --agent zeus`, reaches
  Seneca and he answers in persona in Telegram.
- **S2** `systemctl --user start seneca-standup.service` on the laptop puts the
  letter (summary verbatim, framed) in Telegram, `standups/<date>.md` on the
  server, and exits 0; `systemctl --user list-timers` shows the next run at 09:30.
- **S3** An empty summary or a bad date is rejected by the intake with its exit
  code and nothing reaches Telegram; a failing laptop step raises the
  notification.
- **S4** A work reminder through Seneca is scheduled, shows in his `remind-list`,
  and is removed with `remind-rm`.
- **S5** Regression: `bash bin/remind.test.sh` prints `OK`;
  `openclaw channels status --probe` shows one poller; Zeus's binding is intact;
  the other gods still answer.

## Rollback

Laptop: `systemctl --user disable --now seneca-standup.timer`. Server: restore the
backed-up files, remove `seneca` from `tools.agentToAgent.allow`, `openclaw
approvals allowlist remove --agent seneca "/home/openclaw/bin/agents/seneca/remind*"`,
`openclaw agents delete seneca` (it prunes the workspace too, `standups/`
included), remove `/home/openclaw/bin/agents/seneca`.

## Out of scope

GitLab or Jira access from the server; OpenClaw HTTP hooks; Seneca writing the
summary himself; group chats; non-owner users. Noted while designing, not fixed
here: `collect.sh monday` resolves to the *next* Monday under GNU `date`, so that
window is empty mid-week (the job uses `3d` instead).
