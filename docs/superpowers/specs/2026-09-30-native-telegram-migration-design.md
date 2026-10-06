# Migrate Pantheon to OpenClaw's native Telegram channel

Status: approved 2026-10-06, cut over the same day on OpenClaw 2026.9.7.

OpenClaw's built-in Telegram channel replaces Pantheon's grammY bot. The Bun
service no longer runs and its code is deleted from this repository; the gods,
their personas and workspaces stay in OpenClaw.

## Decisions

1. **Zeus orchestrates.** The owner's DM is bound to agent `zeus`. Every owner
   message reaches Zeus first. He answers general matters himself and hands
   specialist work to Hermes (`main`), Athena, Heracles or Aphrodite.
2. **The specialist replies directly.** Zeus hands off with `sessions_send` into
   the specialist's own main session (so its memory and continuity stay its own)
   without waiting. The specialist replies to the owner's chat itself with the
   `message` tool. Zeus's own turn ends silently (`NO_REPLY`).
3. **Zeus decides every message from scratch.** No pinning. Follow-ups go to
   whoever had the topic last.
4. **Zeus's transcript is the hand-off record.** His own `sessions_send` calls
   are the only note he keeps; he does not read other gods' sessions
   (`sessions_history` and `sessions_search` are denied for him), so Aphrodite's
   ledger stays unreadable to him.
5. **Owner only, for now.** `@dednasralvkolodets` never messaged the bot, so the
   numeric Telegram id needed for `allowFrom` and a binding is unknown; that user
   is not migrated. Users are added by hand (README, "Adding a user"); each gets
   its own `u_<id>` agent bound to its own chat and no orchestration.

## What replaced what

| Pantheon | After migration |
|---|---|
| grammY bot, username allowlist | `channels.telegram`, `dmPolicy: "allowlist"`, numeric `allowFrom` |
| Registry: user → agent | one peer binding per user in `bindings` |
| Auto-provisioning on first message | manual: `openclaw agents add u_<id>` + workspace + policy + wrappers + binding + `allowFrom` |
| Router (pin → keywords → Groq classifier) | Zeus's judgement (decisions 1, 3) |
| `/tell` endpoint, loop guard, rate cap | `sessions_send` between gods; persona rules plus OpenClaw's 5-turn ping-pong cap |
| `/notify` endpoint (reminders) | cron command job announced to `telegram:<chat>` |
| Groq voice transcription | OpenClaw's Groq plugin (`tools.media.models`) |
| Markdown→HTML, splitting, typing, `NO_REPLY` handling | native |
| Document intake into `inbox/` | OpenClaw media store, `~/.openclaw/media/inbound/`; Zeus passes the path |
| `god-announce` (Athena's pushes) | the `message` tool |

## Config (`~/.openclaw/openclaw.json`, as applied)

```json5
{
  channels: {
    telegram: {
      tokenFile: "/home/openclaw/.openclaw/telegram-bot-token",   // 600
      dmPolicy: "allowlist",
      allowFrom: ["1307366032"],
      groupPolicy: "allowlist",                                   // groups blocked
    },
  },
  bindings: [
    { agentId: "zeus", match: { channel: "telegram", peer: { kind: "direct", id: "1307366032" } } },
  ],
  tools: {
    agentToAgent: { enabled: true, allow: ["zeus", "main", "athena", "heracles", "aphrodite"] },
    media: { models: [{ provider: "groq", model: "whisper-large-v3", capabilities: ["audio"] }] },
  },
  // agents.entries.<id>.tools: see README "Tool policies". Deltas made here:
  //   zeus.deny      += sessions_history, sessions_search
  //   heracles.deny, aphrodite.deny: group:sessions -> its members minus sessions_send
}
```

`GROQ_API_KEY` lives in `~/.openclaw/.env` (600); the gateway reads it at start.
Plugin: `@openclaw/groq-provider`. `env.vars.PANTHEON_NOTIFY_SECRET` is removed.

## Persona changes (live files edited in place; `gods/` mirrors them)

- **Zeus:** hands off with `sessions_send {sessionKey: "agent:<god>:main",
  message: <owner's words verbatim + "File: <path>" lines>, timeoutSeconds: 0}`
  and ends with `NO_REPLY`; answers any reply that bounces back with
  `REPLY_SKIP`; no `tell`, no `exec`. The specialists already know the owner's
  chat id, so he passes none.
- **Each specialist ("Your mortal's chat"):** a message from
  `agent:zeus:main` is the owner speaking; answer with
  `message {action: "send", channel: "telegram", target: "<owner chat id>"}`
  and end with `NO_REPLY`. Aphrodite's rule "never contact anyone" is kept: the
  tool answers the owner only.
- **Word between gods:** `sessions_send`, one hop, a fact only; the receiver
  files it, acknowledges to the owner in one line via `message`, ends with
  `NO_REPLY`. Recipients never include `zeus`.
- **Reminders:** unchanged wrappers; one added hint about link masking.
- Live-only edits (Russian-language rules, Hermes's calendar laws,
  `birthday-sync`) were preserved; each file's checksum was verified against the
  fetched copy before install.

## Verified mechanics (OpenClaw 2026.9.7: bundled docs + source)

- **`sessions_send`** selects local model context, not a delivery target
  (`docs/concepts/session-tool.md:164`). Fire-and-forget is `timeoutSeconds: 0`
  (`:170`). The target sees `[Inter-session message] sourceSession=… sourceTool=sessions_send isUser=false`
  (`src/sessions/input-provenance.ts`). In `src/agents/tools/sessions-send-tool.a2a.ts`
  the flow ends at once when the target's terminal reply is a silent token
  (`NO_REPLY`, `REPLY_SKIP`, `ANNOUNCE_SKIP`, `HEARTBEAT_OK`;
  `sessions-send-tokens.ts`); otherwise it runs up to 5 ping-pong turns
  (hard-coded, `sessions-send-tool.ts`; the old `maxPingPongTurns` key is retired)
  starting with the requester, then an "announce step" turn on the target.
- **`message` tool** params `action`, `channel`, `target`, `accountId`,
  `message` (`src/agents/tools/message-tool-schema.ts`); it is `group:messaging`,
  allowed for every god. `tools.message.crossContext.allowAcrossProviders`
  defaults to true.
- **Tool groups** (`docs/gateway/config-tools/tool-policy.md:69-74`):
  `group:sessions` = sessions, sessions_list, sessions_history,
  sessions_search, conversations_list, conversations_send, conversations_turn,
  sessions_send, sessions_spawn, sessions_yield, subagents, session_status,
  suggest_task, dismiss_task.
- **Cron command payload** (`docs/automation/cron-jobs/payloads.md:169-191`): runs
  on the gateway host with no model turn; non-empty stdout is delivered verbatim;
  a lone `NO_REPLY` is suppressed. CLI: `cron add [scheduleOrName] [message]` plus
  `--name --agent --at|--cron --command-argv --command-input --announce --channel --to --delete-after-run`;
  `cron edit … --no-best-effort-deliver`. Proactive DM delivery needs `delivery.to`
  or an `allowFrom` entry (`delivery.md:101`). Output on lines that read like login
  prompts is masked (`src/cron/command-output-summary.ts:5-15`, applied in
  `server-cron.ts`).
- **Why the remind wrappers stay:** command payloads are an operator-admin
  surface, not something an agent can create directly; the wrappers run as the
  `openclaw` OS user and the per-agent exec allowlist is still the only unforgeable
  attribution (`payloads.md:176`; README "Why wrappers").
- **Telegram:** token precedence `tokenFile` > `botToken` > env; `allowFrom`
  numeric (`tg:`/`telegram:` prefixes normalised); `groupPolicy` defaults to
  `allowlist`; a second poller shows as HTTP 409
  (`docs/channels/telegram/{setup,access-control,messaging}.md`). Peer bindings go
  through `config set bindings`; `openclaw agents bind` binds whole channels only.
- **Voice:** `@openclaw/groq-provider`, default model `whisper-large-v3-turbo`;
  pinned to `whisper-large-v3` (`docs/providers/groq.md`).
- **Inbound documents:** stored under `~/.openclaw/media/inbound/`.
- **Pre-existing bug fixed on the way:** `bin/remind-impl/{remind-lib,remind-in}`
  pinned `PATH` to `tools/node-v24.15.0/bin`, deleted by the 2026-09-30 Node
  upgrade, so no god could schedule a reminder (`openclaw: command not found`,
  hidden by `|| true`). The helpers now use the `tools/node` symlink.

## Cutover, as executed (2026-10-06, UTC)

1. 10:42 Backup: `~/pantheon-migration-backup-20261006-104233` (openclaw.json,
   `~/bin`, persona `*.md`, cron and approvals JSON, notify secret).
2. Token to `~/.openclaw/telegram-bot-token`, `GROQ_API_KEY` to `~/.openclaw/.env`
   (both 600, values never printed).
3. `openclaw plugins install @openclaw/groq-provider` (applied live).
4. Hot config: `tools.media.models`, `tools.agentToAgent`, tool-policy deltas;
   `config validate` ok; `gateway restart` so the gateway reads the new `.env`.
5. New remind helpers + `owner-chat` installed; `bash remind.test.sh` → OK on the
   host; `remind-list` works again.
6. 11:10 `docker compose down` in `/opt/pantheon` (port 8477 closed); persona
   files installed after a checksum check; `tell` wrappers, their five allowlist
   entries, `god-announce` and the notify secret file removed; `bindings` and
   `channels.telegram` set (channel hot-started, no 409); the two weekly
   reminders converted with `cron edit` (same texts and schedules, announce to
   telegram:1307366032, best-effort off); `env.vars.PANTHEON_NOTIFY_SECRET`
   removed (this triggered one clean gateway restart).
7. Checks: `channels status --probe` → Telegram running (`@bgpantheonbot`, token
   works); `agents bindings` → `zeus <- telegram peer=direct:1307366032`;
   `remind-in "1 minute" migration-smoke …` → run `ok`, `delivered: true`,
   Telegram `sendMessage` ok (message 513); `remind`/`remind-list`/`remind-rm`
   through Heracles's wrappers ok.
8. 11:18 A hand-off test run from the CLI (`openclaw agent --agent zeus …`)
   started a second Node process next to the ~1 GB gateway on a 1.9 GB box with
   no swap. The VPS froze and was rebooted at 12:05 (last journal entry 11:48,
   no kernel OOM line). The test never completed. Mitigation: npm/apt caches and
   old journal cleared (+550 MB), a persistent 768 MB `/swapfile` added. Rule
   from here: no agent turns from the CLI on this host; the remaining checks
   use the owner's real Telegram messages.
9. Still to confirm with real messages: Zeus answers a general question; a
   reminder request reaches Hermes, who answers directly and the reminder
   arrives; a voice note is transcribed (Groq); a file reaches Athena via its
   path. Also unverified: whether the gateway's memory settles below its warning
   threshold with the Telegram channel active.

## Rollback

1. `cp ~/pantheon-migration-backup-20261006-104233/openclaw.json ~/.openclaw/openclaw.json`
   (removes `channels.telegram`) and `openclaw gateway restart`.
2. Restore `~/bin` and the persona files from the same backup.
3. `cd /opt/pantheon && git checkout pantheon-last-container && docker compose up -d --build`
   (tag = last container commit `e6ef85e`; the `pantheon:latest` image is kept).
4. The two weekly reminders need their old `/notify` payload back (`cron.json`
   in the backup).

## Known losses

- Pantheon's chat history did not carry over (sessions are `agent:<id>:main`);
  workspace memory files are unaffected.
- No self-provisioning of new users.
- `/hermes`, `/athena`, `/gods`, `/auto` are gone; the owner just talks to Zeus.
- A specialist's answer costs two model turns.
- Inbound files stay in OpenClaw's media store; gods with `fs.workspaceOnly`
  (Heracles, Aphrodite) cannot read them.
- OpenClaw does not echo a voice note's transcript back.
- The host is memory-constrained: the gateway alone exceeds its own RSS warning
  threshold; swap prevents a freeze but does not make it fast.
