# Pantheon usage and portfolio-terminal audit

Date: 2026-11-12. All specialists used GPT-6.1 Sol Fast.
Research only: no product code, server configuration, deployment or agent turns changed.

## Bottom line

Improve reliability and make the actual three-agent household understandable
before adding a full game-like interface. Pixel companions fit the current
terminal well. A public persona demo is feasible; exposing personal gods through
the current public assistant endpoint is not safe.

## Evidence and coverage

Coordinator independently verified the current server SQLite stores, selected
configuration, service/listener state and installed documentation using
`.slim/deepwork/pantheon-usage-terminal-audit/verify-server.py`.
The script opens databases with `mode=ro`, decodes current compressed events and
prints aggregates without private transcript content or secrets. Outputs are in
that directory's `server-evidence.txt` and `service-evidence.txt`.

- Installed OpenClaw package: **2026.10.10**. Gateway service active/running;
  observed listeners are IPv4/IPv6 loopback port 18789. This is not an exhaustive
  external reverse-proxy/firewall exposure assessment.
- Configured agents: **Hermes (`main`), Zeus, Seneca**. Athena, Heracles and
  Aphrodite have retained historical databases but are not configured agents.
- Global tools profile is `full`; Hermes has no per-agent tools override.
- Current retained transcript stores contain **2,547 events**, including system
  metadata: Hermes 1,607; Zeus 667; Seneca 121; Athena 39; Heracles 56; Aphrodite 57.
  Current records span Aug 16–Nov 12 UTC. These are not owner-message totals or
  all-time usage statistics. User-role messages also include automation.
- Hermes has 87 retained calendar tool results and 135 exec results. These show
  practical calendar/operational use, not 87 successful calendar changes.
- Cron receipts cover Oct 1–Nov 12: **70 ok, 29 error, 64 skipped, 1 interrupted**.
  All 29 errors date Oct 1–Nov 1: **28 connection-refused, 1 HTTP 403**. Historical
  failures do not prove the provider is currently down; `ok` alone is not proof
  of message delivery.
- Hermes has **13 message-tool error results on Nov 6**, not necessarily 13
  failed owner requests. Specialist inspection attributes them to argument/schema
  friction; coordinator independently reproduced the count and timestamps.
- Ten stored cron jobs, six enabled. Fourteen saved standup date files span
  Oct 8–Nov 12, including Nov 9–12. Missing files alone do not establish why an
  expected day was absent.
- Telegram group policy is allowlist, but a configured group has wildcard sender
  allowance and no mention requirement. README's universal group-blocking claim
  does not describe this configuration; full admission behavior was not tested.

The usage specialist also inspected bounded reset/deleted archives and 90 legacy
JSONL files. That wider scan reported handoff restart-recovery problems and
substantial Zeus usage for AI-limit questions. The coordinator did not reproduce
its full historical deduplication or human-transport classification, so no exact
historical owner-message totals or handoff counts are asserted here.

## Improvements, in priority order

1. **Observable delivery and recovery.** Track provider availability, handoff
   outcome and final delivery separately. Show one clear failure state; bound
   retries and avoid silently ending after a failed handoff. Historical connection
   failures and message-tool errors make this more valuable than elaborate motion.
2. **Validate message-tool arguments before repeated attempts.** Cover supported
   message shapes with fixtures and regression checks; stop identical failures
   with actionable diagnostics rather than spending more model turns.
3. **Make Seneca's routine auditable.** One date/run identifier, explicit
   collected/generated/stored/delivered states, safe retry/idempotency rules, and
   a calendar of expected versus received standups. Check saved coverage rather
   than counting preview invocations as separate days.
4. **Align templates, documentation and live policy.** Show the real active roster,
   reconcile group admission claims and review Hermes's broad tools intentionally.
   Do not automatically revive parked gods or disable useful capabilities blindly.
5. **Reduce noise and expose useful status.** Summarize skipped heartbeat work,
   delivery errors and automation health without presenting skips as model turns.
   Add trustworthy usage/budget telemetry; zero recorded cost is not zero billing.

## Terminal integration: verdict and architecture

The sibling repo is clean at commit
`2ebe722520a4f842c606214ad5cd53f9075e17b4`. Its terminal is a browser simulation,
not a shell. Existing AI SDK callbacks and text streaming are reusable.

**Public persona demo: GO, narrowly scoped.** Keep the public CV assistant; add
original visual/personality presets and public curated knowledge if desired.
No personal memory, tools, credentials, delegation or personal Gateway connection.

**Private personal-god client: CONDITIONAL GO.** Add a separately authorized chat
endpoint, preferably on a dedicated hardened/private origin. Use server-owned
agent/conversation routing and private Gateway ingress. Evaluate paired/scoped
WebSocket authentication supported by installed documentation; verify actual
RPC/session/agent grants before relying on it. A private server-side HTTP broker
is another option, but its shared Gateway bearer remains full operator authority.

**Public access to personal gods: NO-GO.** Separate session keys or another agent
on the same personal Gateway are not a tenant-security boundary. Public live tools
require a separate constrained deployment/trust boundary. Even a visitor-only
Gateway does not automatically isolate mutually untrusted visitors from each other.

Confirmed source blockers in `../begenchgeldyev`:

- `apps/site/server.ts:47–51` and `ask/ask.controller.ts:66–124`: current `/api/ask`
  is public and does not check the owner session. Admin authorization is separate.
- `components/terminal-emulator.html:120–175,186–197`: command-error input can reach
  `innerHTML`. This is a static user-input/self-XSS finding, not proof of a remotely
  delivered exploit. Assistant stream text already uses `textContent`; preserve it.
- Public-origin external scripts and trusted-author raw project HTML enlarge the
  execution trust boundary. A separate privileged origin is the simpler route;
  thoroughly hardening a same-origin client is possible, not inherently forbidden.
- Existing rate limits/body limits help, but owner/global spend, concurrency and
  total-run deadlines need explicit enforcement for privileged agents.

Before launch, test actual endpoint authorization, conversation substitution,
Origin/CSRF/XSS controls, routing/header overrides, secret-free browser traffic,
effective tool/filesystem/network restrictions, partial-stream failure and
cancellation. Disconnect is not rollback of an already-performed tool action.

## Pixel-god recommendation (designer proposal, not approved design)

Start with **terminal companions**, not a full Terraria-like world: one original
Zeus portrait, an expandable labeled roster and a portrait beside each response.
Keep the existing dark monospace/green/amber aesthetic. A later noticeboard can
surface real tasks; a navigable pixel courtyard is an optional later experiment.

- Buttons and optional `gods` / `talk zeus` aliases, without requiring command
  memorization. Only show real configured gods as available in personal mode.
- Show confirmed responder/handoffs and honest connecting/streaming/interrupted
  states; do not animate a success that the backend has not confirmed.
- Brief selection motion, optional active sprite frames, static reduced-motion
  fallback. No artificial typing delay, constant particles, or game engine needed.
- Preserve drafts/partial answers, explicit retry, mobile wrapping/touch controls,
  keyboard focus and the ability to Tab out of the input.
- Use original pixel art, not copied Terraria assets. Public demo and private
  personal mode must have explicit, materially different capability labels.

No rendered mockup or usability test was performed. The first useful owner
workflow remains a design question, not an agreed requirement.

## Sources and remaining uncertainty

See [official source notes](2026-11-12-openclaw-integration-sources.md).
Installed HTTP documentation independently confirms the full-operator bearer
warning; installed WS documentation describes paired device scopes and rotation.
Neither is a runtime authorization test.

Open: full historical owner totals, billing, external proxy exposure, historical
archive deduplication, effective runtime endpoint/isolation tests and rendered UX.
No security certification, implementation approval or deployment readiness is claimed.
