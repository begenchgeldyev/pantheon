# Pantheon reliability: stages, alerts, message guard, real roster

Status: approved for local implementation/testing on 2026-11-12; live deployment
not approved. User selected **CLI details + Telegram alerts**.
Scope: implement the four requested audit improvements in this repository;
deployment and live activation require separate approval. All specialists use
GPT-6.1 Sol Fast. This is not a deepwork activation.

## Intent and boundaries

Make native automation and the laptop/server standup explain what happened,
reject known invalid message arguments before execution, and describe the actual
Hermes/Zeus/Seneca household. Preserve all seven pre-existing modified files as
the baseline; their snapshot is `.slim/deepwork/pantheon-reliability/baseline.patch`.

No website, pixel-art work, new Telegram poller, bot-token copying, vendor edits,
automatic revival of parked agents, provider migration, or historical resend.
Existing Seneca formatting-only instructions remain intact. A server status report
cannot invent laptop stages it never received. No delivery/read guarantee is
possible from a successful Telegram API send.

## Verified constraints

- Current intake ignores `--json` and labels every exit 0 delivered. Same-date
  reruns overwrite and send again; SSH 255 can occur after remote acceptance.
- Timer is weekdays 07:00 Asia/Tomsk, but script date currently uses host timezone.
  Collector accepts a relative window, not a historical requested date.
- OpenClaw 2026.10.10 has typed `api.on('before_tool_call', ...)` enforcement.
  Explicit blocks are model-visible and the installed global dispatcher is
  fail-closed. An observation hook cannot enforce this policy.
- Native identical-error detection already terminates after three consecutive
  matching failures. A block prevents execution, not an immediate end to a run.
- Installed CLI documents separate agent processing and delivery status, including
  `sent`, `suppressed`, `partial_failed`, and `failed`. Process exit is not a
  delivery receipt. Missing/unrecognized/contradictory evidence stays unknown.
- Native cron read APIs expose more delivery information than the internal
  `cron_run_receipts` table. Monitor through supported CLI interfaces.

Source excerpts and baseline test results live under
`.slim/deepwork/pantheon-reliability/`; no live agent/send probe was run.

## 1. Durable standup lifecycle and safe retries

Keep the existing summary file location, with protected metadata outside persona
content. Record logical date, attempt identity, summary hash, actual UTC times,
collection window, stage/outcome, native run reference when available, and bounded
error categories. Exclude summaries, raw stderr/model output, chat IDs and secrets
from report metadata. Existing journals remain operator diagnostics.

Report independent facts rather than a misleading single success flag:

- laptop: started, collection completed, generation completed, submission outcome;
- server: input stored, native acceptance observed, processing completed/failed/
  unknown, delivery sent/suppressed/partial_failed/failed/unknown;
- legacy file without metadata: **stored only**, all later stages unproven.

Parse top-level and nested native delivery envelopes conservatively. Fixed
requested routing is Telegram to the configured owner; any reported routing
contradiction invalidates a sent conclusion. Conflicting envelopes cannot upgrade
failure/unknown to sent. Describe sent as platform-send acknowledgement, never
recipient display/read. Preserve a native run ID after timeout if available.

Exact first-version agent parser contract:

- `processing=succeeded` requires explicit terminal native `status` equal to `ok`
  or `completed` with no contradictory failure. CLI exit 0 or delivery evidence
  alone does not prove processing completion. `accepted`/`in_flight` is pending;
  missing/unrecognized processing evidence is unknown.
- Delivery can be reported independently even if processing failed or is unknown.
  A consistent native `deliveryStatus` with `status=sent`, `requested=true`,
  `attempted=true`, and `succeeded=true` permits **sent (OpenClaw reported)**.
  A zero/invalid reported result count or conflicting failure makes it unknown.
  A provider message ID is stronger evidence but is not required when the native
  CLI exposes only its authoritative send projection. Record the evidence source.
- Concrete direct-send alert receipts use their documented provider IDs; an ID
  representing only the destination is not send evidence. Never label either
  native projection or provider receipt recipient-delivered/read.

Use atomic metadata writes and per-date locking. The default same-date/same-hash
submission returns its recorded state without invoking Seneca again. Changed
content for an existing date requires explicit operator replacement/resend.
Uncertain or interrupted attempts are not automatically resent, including after
SSH 255. Explicit retry/resend must warn that an unknown prior outcome can duplicate
work. A stored summary is resumable without recollection/regeneration.

Retain current root-to-openclaw execution and ownership intent. Protect state
directories/files; bound inputs and validate dates before paths/commands. Record
actual collection time/window so backdated labels never imply backdated data.
Use Asia/Tomsk for logical dates consistently.

## 2. Read-only CLI status and non-model alerts

Provide a server `pantheon-status` command with text and `--json` output covering:
configured active agents, native cron processing/delivery outcomes, standup
coverage/stages and monitor/alert health. Native reads have bounded timeouts and
pagination. Show source, observation time, unavailable sources and coverage gaps.
Local laptop status must also be inspectable without running collection, models,
SSH submission or sending. The builder may settle the exact local command syntax.

Use supported `cron list --all --json` and paginated `cron runs` output; distinguish
execution success from delivery. Historical failures remain visible, not presented
as current provider downtime. Never hardcode the audit's 29-error snapshot as a
live total or count expected empty-heartbeat skips as failed model turns.

Add a separate checker for **new terminal failures and missed standups**. Chosen
defaults (coordinator proposals, not prior user requirements):

- weekdays, Asia/Tomsk; 07:00 expected, **07:30 grace deadline**;
- at 07:30, no stored input is `missing_input`; stored input satisfies input
  coverage, not end-to-end success. If it remains in flight or delivery-unproven
  at **07:45**, send one distinct `standup_incomplete` alert. A late arrival gets
  at least 15 minutes after storage before an incomplete alert;
- explicit processing failure, failed/partial send, or suppressed expected
  standup delivery is alertable immediately after observation, once per attempt;
  ordinary cron suppression/no-delivery-required and expected heartbeat skips
  are informational unless native outcome independently reports a failure;
- expected coverage begins on explicit monitor initialization, not August history;
- configurable pauses/excluded dates; no automatic holiday calendar;
- no recovery/success notifications initially; details remain in CLI output;
- server checker every five minutes, without model turns;
- deduplicated, bounded plain-text failure/missed-standup alerts to owner only.

Initialization snapshots completed native history without sending backlog alerts,
and remembers already in-flight runs so their subsequent failures are not lost.
Polling uses overlap and stable run identities. Detect pagination/retention gaps
instead of claiming completeness. Keep monitor state separate from native tables.
Legacy stored files report unknown delivery, not confirmed sends. A missing input,
failed processing and unproven delivery are different conditions and alert text.

Use `openclaw message send --channel telegram --target ... --message ... --json`,
with the configured System Agent, existing credentials and protected owner-chat
resolution. This is not an agent/model turn and takes no `--agent` flag. Persist
an attempt before dispatch; classify queued, sent/provider-ID, failed and ambiguous
results separately. Suppress concurrent/repeated alert attempts. Retry only
provably pre-dispatch failures with bounded backoff; uncertain sends require
operator reconciliation. Do not promise exactly-once delivery across a crash.
Alert failures remain visible locally and cannot recursively send more alerts.

Server monitoring detects a laptop that never submitted after the grace deadline;
it cannot immediately explain an unreachable laptop's internal failure. Local
durable stage/error evidence supplies that detail. No new early-stage upload
protocol is required in the first version.

## 3. Supported pre-execution message validation

Add a separately installable Pantheon-owned OpenClaw plugin and pure testable
validator. Scope to the normalized underlying `message` tool, including calls
reached through `dispatch_action`; leave unrelated tools/channels unchanged except
where a documented shared constraint applies.

Reject known unsafe/invalid combinations with deterministic field-only repair
instructions: Telegram `clawhub`, simultaneous seconds/hours poll duration, invalid
duration numbers, whitespace-only optional location text, invalid coordinates/
accuracy, incomplete venue name/address pairs, unsupported location fields, and
location mixed with incompatible text/media. Validate the applicable action so
legitimate text, poll and coordinate-only messages continue working.

Do not silently remove meaningful fields, choose a duration, or reroute a card.
Known irrelevant optional defaults in huge argument objects must not create false
invalidity; fixtures distinguish absent/default placeholders from real payloads.
Do not recreate the entire evolving OpenClaw schema or make the normal send path
more restrictive without evidence.

Rejecting external Telegram `clawhub` is an explicit deployment policy: the
currently installed implementation may silently discard it on an explicit
external route. Do not claim its historical exception necessarily reproduces on
the current build. The guard instead asks for a supported plain Telegram message.

Return `{block:true, blockReason:<stable repair instruction>}` before execution.
Identical invalid arguments receive identical reasons and zero executor calls;
corrected arguments may proceed. Rely on the existing native three-error stop,
rather than claiming the plugin terminates runs immediately or adding global
retry counters that mix sessions. Document the dependency and verify the real
hook/loop integration in an approved isolated harness before live activation.

Update persona guidance to construct minimal action-specific message arguments
and repair deterministic validation failures rather than blindly retrying. Prompt
guidance supplements the plugin; it is not the enforcement mechanism.

## 4. Real household and installation

Document Hermes/main, Zeus and Seneca as observed active agents, dated to this
audit. Retain Athena/Heracles/Aphrodite as parked templates/history. Align Zeus
and Seneca routing/kin references without deleting persona history or treating
directories as runtime configuration. A future selector must use configured
agents, not template-directory enumeration; no website selector is built here.

Correct stale group-policy and Seneca-formatting claims. Keep observation separate
from reproducible setup examples. Template edits do not change live workspaces.

Provide explicit installation/activation/rollback instructions and extend CI
checks/install lists for repo-owned files. Package the plugin and monitoring units
separately; no install or timer/plugin enablement happens implicitly while testing.
If a controlled Gateway reload is needed, document it rather than performing it.
Preserve the existing runtime model choice unless the user separately changes it;
the all-Sol-Fast requirement applies to this coding session's specialists.

## Verification contract and ownership

Coordinator owns acceptance and final integration checks. Each writer owns
test-first evidence for its disjoint scope; all final artifacts are inspected.
Use standard-library Python for durable monitoring/state helpers where appropriate,
existing Bash entrypoints, and Bun tests for the TypeScript plugin. Add no runtime
dependency or remote SDK installation without a demonstrated need.

- lifecycle fixtures: accepted-only, exit-0/no receipt, malformed/contradictory
  JSON, sent/suppressed/partial/failed, timeout after acceptance, duplicate hash,
  changed content, crash/concurrency, resume, legacy file and ownership seams;
- monitor fixtures: baseline/no backlog, in-flight completion, overlap/pagination,
  gaps, source unavailable, weekdays/weekends, grace/date rollover, paused dates,
  alert concurrency/dedupe/ambiguous send and failed alert without recursion;
- guard fixtures: minimal valid operations, all known invalid cases, synthetic
  101/102-field objects, direct/deferred underlying calls, stable redacted reason,
  zero executor calls on blocks and corrected input allowed;
- run existing reminder, intake and laptop regression suites plus new tests;
  verify CLI read-only behavior, shell syntax, state redaction and install paths.

Local mocked tests do not certify native hook loading, loop termination, real
Telegram acceptance, root/runuser behavior or production scheduling. These remain
explicit live/isolated-harness checks requiring approval. No model/send invocation
is hidden inside verification. Work is not called deployed while those checks wait.
