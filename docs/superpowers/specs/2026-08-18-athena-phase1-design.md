# Athena (job-hunt god) — Phase 1 design

Date: 2026-08-18
Status: approved (conversational)
Branch: `athena` (off `multi-user`)

## Vision (the pantheon)

Pantheon becomes a pantheon of gods the owner talks to through one Telegram bot:
- **Zeus** — throne-room router (later phase): reads intent, delegates to the right god, sticky per topic, explicit override wins, cheap-first (only deliberates on ambiguous requests).
- **Hermes** (`main`) — dates & reminders. Already built.
- **Athena** — vacancy hunt: search, parse, scored updates, résumé weaving, later assisted/auto apply.

Sequencing: **Athena Phase 1 first** (Zeus has nothing to route until she exists), then Zeus, then Athena Phase 2 (gated auto-submit).

## Phase 1 scope (this spec)

Owner-only. "Athena reachable, self-configuring, on-demand." Ships value without the owner handing over any data up front — she is configured by talking to her in Telegram.

In:
1. A second OpenClaw agent `athena` (owner-bound), web-enabled, own workspace/persona.
2. Owner persona-switching in Pantheon: `/athena`, `/hermes`, `/gods`; sticky per-chat active god.
3. Résumé / document upload over Telegram (Pantheon is text-only today — new capability).
4. Conversational onboarding: Athena asks what you're hunting and stores prefs + sources + résumé path in her own workspace (MEMORY).
5. On-demand search: Athena fetches job-board JSON APIs via `web_fetch`, parses, scores against stored prefs, replies. Résumé weaving (tailored résumé + cover letter) happens in chat — no extra infra.

Out (later phases): Zeus router; scheduled proactive vacancy pushes (Phase 1b: cron → Athena → notify); auto-submit (Phase 2, gated).

## Verified facts (on kz)

- `main` runs tool profile `full` (not sandboxed) → web tools available. No search-provider configured, so Athena fetches **known JSON endpoints directly** rather than open web search.
- `web_fetch` works: confirmed against `https://remotive.com/api/remote-jobs?limit=1` (returned the job JSON).
- OpenClaw multi-agent: `openclaw agents add <id> --workspace … --agent-dir … --non-interactive`; per-agent tools via `agents.list[i].tools`; `agents.*`/`tools.*` hot-reload.

## Design

### 1. The `athena` agent
- Created once (deploy step, not the per-user provisioner): `openclaw agents add athena --workspace ~/.openclaw/workspace-athena --non-interactive`.
- Tools: owner-trust, NOT sandboxed. Allow web + fs + exec; **deny `google-calendar__*`** (that's Hermes's). No `fs.workspaceOnly` restriction (she may read her own résumé/inbox; she's the owner's agent). Explicitly: `agents.list[athena].tools = { deny: ["google-calendar__*"] }` (inherits `full` profile otherwise).
- Model: `cliproxy/claude-sonnet-4-6`, `maxTokens` inherited from provider (now pinned in openclaw.json).
- Persona files versioned in repo at `gods/athena/` and installed to her workspace on deploy: `IDENTITY.md`, `SOUL.md` (Athena voice — wisdom, strategy, weaving), `AGENTS.md` (her charge + the source-fetch playbook), `TOOLS.md` (the JSON endpoints & patterns), `USER.md` (owner), empty `MEMORY.md` (she fills it: prefs, sources, résumé path).

### 2. Owner persona-switching (Pantheon)
- Config: `PANTHEON_OWNER_GODS` (comma list of extra agent ids the owner may summon, e.g. `athena`). Owner may always summon `main`.
- New durable per-chat selection: table `chat_selection(chat_id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, updated_at TEXT NOT NULL)` in `users.sqlite`.
- `godsFor(userId)`: owner → `["main", ...ownerGods]`; other users → `[their registered agentId]`.
- Router resolves the **active** agent: `chat_selection` for the chat if set and still in `godsFor`, else the user's registered agent. Session key stays `telegram:<uid>:<chat>` (OpenClaw scopes it per `--agent`, so each god keeps its own thread).
- Commands (owner; no-op/hidden for single-god users):
  - `/hermes [msg]` → select `main` (and, if msg present, route it there once).
  - `/athena [msg]` → select `athena` if in owner's gods, else reply it's not summoned.
  - `/gods` → list summonable gods and which is active.
- Generic: for each extra god id that is a valid command name, register `/<id>` the same way (so future gods get commands for free).

### 3. Document upload
- `bot.on("message:document")` (and `:photo` optional later). Guard: owner/allowed only (same auth middleware).
- Download via `bot.api.getFile` + fetch file URL; cap size (e.g. 20 MB); allow doc types (pdf, md, txt, docx, rtf).
- Save into the **active** agent's workspace under `inbox/<original-name>` (sanitised). For the owner+Athena a résumé thus lands in `workspace-athena/inbox/`.
- Then run an agent turn on the active god: message like `[system] The user uploaded a file to your workspace: inbox/<name> (<mime>, <size>). Acknowledge and act as appropriate.` so she can read it, store the path in MEMORY, and confirm in-voice.
- Errors (too big, unsupported, download fail) → friendly reply.

### 4. Conversational onboarding & prefs
- Pure persona/behaviour: Athena's `AGENTS.md` instructs her, on first contact or when prefs are missing, to ask for target roles, stack/keywords, location/remote, min comp, dealbreakers, and to store them in `MEMORY.md`. No Pantheon code.

### 5. On-demand search
- Persona/behaviour: `TOOLS.md` lists the JSON endpoints and how to query them; `AGENTS.md` tells her to fetch, parse, score against stored prefs, and present the top matches with links. No Pantheon code beyond web tools being enabled.

## Testing
- Unit (bun test): `godsFor` (owner vs user), chat_selection CRUD, active-agent resolution (selection in/out of gods, fallback), document filename sanitisation & type/size gating, command parsing.
- Live on kz (owner): `/gods` lists Hermes+Athena; `/athena` switches (sticky across messages); ask Athena to find N remote roles → she fetches a board API and returns real listings; send a PDF → lands in `workspace-athena/inbox/`, she acknowledges and records it; `/hermes` returns to reminders and Hermes is unaffected; a non-owner (if any) sees no god commands.

## Migration / ops
- `athena` agent + persona installed by a deploy step (documented), like the owner's remind wrappers.
- No change to Hermes or the multi-user user-provisioning path.

## Status

Phase 1 built and deployed to kz on 2026-08-18 (branch `athena`). 60 tests pass, tsc clean.
Athena agent created (workspace-athena, persona installed, calendar MCP denied, web_fetch verified).
`PANTHEON_OWNER_GODS=athena` enabled; service restarted. Live agent turn: she introduced herself
in-voice and returned three real TypeScript roles from the Remotive API with real apply links and a
candid honest assessment. Telegram-side `/gods` `/athena` switching and résumé upload are unit-tested;
owner to exercise them live. Next: Zeus router (phase 2), then Athena proactive updates + gated auto-apply.
