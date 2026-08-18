# Athena Phase 1 — Implementation Plan

**Goal:** Add a second god (Athena, job-hunt) the owner reaches via `/athena`, who is configured by chat, can receive an uploaded résumé, and searches job-board JSON APIs on demand.

**Architecture:** New OpenClaw agent `athena` (owner-bound, web-enabled). Pantheon gains: owner "gods" set + durable per-chat active-god selection, god-switch commands, and Telegram document upload → active agent's workspace. Athena's behaviour (onboarding, sourcing, weaving) lives in her workspace persona files, not code.

**Tech:** Bun/TS, bun:sqlite, grammY, OpenClaw CLI. Branch `athena` off `multi-user`.

## Global Constraints
- Bun APIs only. Commit locally (git identity configured); no Claude/session refs in messages.
- Owner = the user whose username == `config.ownerUsername`, mapped to agent `main`. Extra owner gods from `PANTHEON_OWNER_GODS` (comma list of agent ids, e.g. `athena`).
- Session key unchanged: `telegram:<uid>:<chat>` (OpenClaw scopes per `--agent`).
- Non-owner users are unaffected: exactly one god (their `u_<id>`), no god commands.
- Deploy target kz: agent `athena`, workspace `~/.openclaw/workspace-athena`, persona from repo `gods/athena/`.

---

### Task 1: Config — owner gods
**Files:** `src/config.ts`, `src/config.test.ts`
**Produces:** `Config.ownerGods: string[]` (agent ids, from `PANTHEON_OWNER_GODS`, comma-split, trimmed, deduped, `main` excluded since it's implicit). Validation: each id matches `^[a-z][a-z0-9_]*$`.
- [ ] Test: `PANTHEON_OWNER_GODS="athena, athena ,main"` → `["athena"]` (dedup, drop main); unset → `[]`; invalid id `"Bad Id"` → throws.
- [ ] Implement, run `bun test src/config.test.ts`, commit `feat(config): PANTHEON_OWNER_GODS owner god list`.

### Task 2: Registry — chat selection
**Files:** `src/registry.ts`, `src/registry.test.ts`
**Produces:** table `chat_selection(chat_id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, updated_at TEXT NOT NULL)`; methods `getChatSelection(chatId): string | null`, `setChatSelection(chatId, agentId): void` (upsert).
- [ ] Test: unset → null; set then get → agentId; overwrite updates agent + updated_at.
- [ ] Implement (create table in constructor alongside `users`), run tests, commit `feat(registry): durable per-chat god selection`.

### Task 3: Gods resolution
**Files:** `src/gods.ts` (new), `src/gods.test.ts`
**Consumes:** `Config`, `UserRecord`. **Produces:**
```ts
export const HERMES_AGENT_ID = "main";
// Agents this user may summon, in display order.
export function godsFor(user: UserRecord, config: Config): string[]; // owner -> [main, ...ownerGods]; else -> [user.agentId]
export function isOwner(user: UserRecord, config: Config): boolean;  // user.username === config.ownerUsername
// Active agent for a chat: selection if still summonable, else the user's registered agent.
export function activeAgent(user: UserRecord, config: Config, selection: string | null): string;
```
- [ ] Tests: owner (username==ownerUsername) → `["main","athena"]` with ownerGods `["athena"]`; non-owner → `[user.agentId]`; `activeAgent` returns selection when in godsFor, falls back to `user.agentId` when selection null or no longer allowed.
- [ ] Implement, tests, commit `feat(gods): summonable gods and active-agent resolution`.

### Task 4: Router uses active selection
**Files:** `src/router.ts`, `src/router.test.ts`
**Change:** `Router` gains `Config`; `route({userId, chatId, text})` resolves the user via registry, computes `activeAgent(user, config, registry.getChatSelection(chatId))`, routes there. Add `activeAgentFor(userId, chatId): string` (replaces/[keeps] `agentFor`). `RouterError` if user unregistered.
- [ ] Tests (registry seeded owner=main + selection athena): routes to athena when selected; to main when no selection; unknown user → RouterError.
- [ ] Implement, tests, commit `feat(router): route to the chat's active god`.

### Task 5: Document intake helpers
**Files:** `src/documents.ts` (new), `src/documents.test.ts`
**Produces:**
```ts
export const MAX_DOC_BYTES = 20 * 1024 * 1024;
export const ALLOWED_DOC_EXT = new Set([".pdf",".md",".txt",".docx",".rtf",".doc"]);
export function sanitizeFilename(name: string): string;   // basename, strip path, keep [a-zA-Z0-9._-], collapse, fallback "file"
export function isAllowedDoc(name: string, size: number): { ok: true } | { ok: false; reason: string };
export function inboxPathFor(workspaceDir: string, agentId: string, name: string): string; // <stateDir root passed in>/workspace-<id...>/inbox/<safe>
```
Keep it pure (no fs); the Telegram layer does the actual download+write given a resolved path.
- [ ] Tests: sanitize strips `../etc/passwd` → `passwd`, keeps `My CV.pdf` → `My_CV.pdf`; disallow `.exe` and oversize; allow `resume.pdf`.
- [ ] Implement, tests, commit `feat(documents): résumé/file intake validation helpers`.

### Task 6: Telegram — commands + document handler
**Files:** `src/telegram.ts`, `src/telegram.test.ts`
**Change (createBot gains `config` already has it? it takes config):**
- After ensure-user middleware, register for the OWNER only (guard with `isOwner`): `/gods` (list `godsFor` marking the active one), `/hermes [msg]`, and one command per id in `config.ownerGods` that is a valid command name (`/athena`). Each `/x [msg]`: if `x` in `godsFor(user)` → `registry.setChatSelection(chatId, x)` and reply "Now speaking with <Name>."; if `msg` present, immediately `handleTurn` routed to the active god. Unknown/!summonable → reply listing gods.
- `bot.on("message:document")`: resolve active agent (`router.activeAgentFor`); `isAllowedDoc` on name+size → if not, reply reason; else `getFile`, fetch file URL, write to `inboxPathFor(stateDir, agentId, name)` (mkdir -p), then `handleTurn` with a synthetic system line `The user uploaded a file to your workspace: inbox/<safe> (<mime>, <size> bytes).` so the active god processes it.
- Exports for test: `parseGodCommand`/`isOwner` already in gods; test the document-name gating via documents.ts (already) and a middleware test that a document from the owner writes to the right path (use a fake `ctx` + a temp stateDir + a stub `getFile`/fetch).
- Config needs `openclawStateDir` (exists) to build workspace path: `workspace-<agentId>` for user gods, but `main`→`workspace`, `athena`→`workspace-athena`. Reuse the provisioner's convention: helper `workspaceDirFor(stateDir, agentId)` = `agentId==="main" ? stateDir/workspace : stateDir/workspace-<agentId>`. Put in gods.ts or documents.ts; test it.
- [ ] Tests: `/gods` lists; `/athena` sets selection (fake registry) and replies; document from owner → written to `workspace-athena/inbox/<safe>` and a turn dispatched to athena (assert via stub); oversize document → reply, no write.
- [ ] Implement, `bun test`, `bunx tsc --noEmit`, commit `feat(telegram): god-switch commands and document upload`.

### Task 7: Athena persona
**Files:** `gods/athena/{IDENTITY,SOUL,AGENTS,TOOLS,USER}.md`, `gods/athena/MEMORY.md` (empty scaffold)
- Athena voice (wisdom, strategy, the loom/weaving); AGENTS.md = her charge: on missing prefs, ask (roles, stack, location/remote, min comp, dealbreakers) and store in MEMORY; sourcing playbook; scoring; résumé weaving; never invent listings, always include the real apply link. TOOLS.md = the JSON endpoints (Greenhouse `boards-api.greenhouse.io/v1/boards/<co>/jobs`, Lever `api.lever.co/v0/postings/<co>?mode=json`, Ashby, Remotive `remotive.com/api/remote-jobs`, RemoteOK `remoteok.com/api`, HN Algolia `hn.algolia.com/api/v1/search_by_date?tags=story&query=...`) and how to query/parse; note web_fetch usage and to respect rate/size. USER.md = owner.
- [ ] No tests (docs). Sanity: no secrets, no owner PII beyond name. Commit `feat(athena): persona and sourcing playbook`.

### Task 8: Docs + deploy notes
**Files:** `.env.example`, `README.md`
- `.env.example`: add `PANTHEON_OWNER_GODS=` (comment: extra agent ids the owner may summon, e.g. `athena`).
- README: new "Gods" section — how to add a god (create agent, install persona, add to `PANTHEON_OWNER_GODS`), the `/gods` `/athena` `/hermes` commands, and résumé upload. Note Athena Phase 1 = on-demand (proactive pushes + auto-apply are later).
- [ ] Commit `docs: gods, god-switching and résumé upload`.

### Task 9: Deploy to kz + create Athena + live smoke
(run as `openclaw`; PATH includes bun + openclaw)
- [ ] Pull branch on kz, `bun install`, `bun test`, `bunx tsc --noEmit`.
- [ ] Create agent: `openclaw agents add athena --workspace ~/.openclaw/workspace-athena --non-interactive`; remove seeded BOOTSTRAP.md; install `gods/athena/*.md` into the workspace (render USER.md owner name); set `openclaw config set 'agents.list[N].tools' '{deny:["google-calendar__*"]}'` where N = athena's index; verify `web_fetch` available (agent turn fetching Remotive).
- [ ] `.env`: add `PANTHEON_OWNER_GODS=athena`; restart pantheon (user bus).
- [ ] Smoke (owner Telegram): `/gods` shows Hermes+Athena; `/athena` → sticky; "find me 3 remote senior TS roles" → real listings from a board API; send a PDF résumé → lands in `workspace-athena/inbox/`, Athena acknowledges + records path in MEMORY; `/hermes` → reminders still work, unaffected.
- [ ] Record status in the spec; commit.

## Self-review
- Spec §1 agent → T1,T7,T9. §2 switching → T1,T2,T3,T4,T6. §3 upload → T5,T6. §4 onboarding → T7. §5 search → T7 (+web enabled T9). Testing → per-task + T9 live. Migration/ops → T8,T9. Non-owner unaffected → T3 (godsFor), T6 (owner-guarded commands).
