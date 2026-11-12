# Pantheon Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement truthful automation status, bounded Telegram failure alerts,
pre-execution message validation and accurate household documentation.

**Architecture:** Preserve Bash entrypoints; use standard-library Python for
protected durable receipts and native CLI monitoring. A separate TypeScript
OpenClaw plugin validates the normalized message tool before execution. Independent
writers own disjoint files; monitoring depends on the lifecycle record contract.

**Tech Stack:** Bash, Python 3 standard library, OpenClaw 2026.10.10 plugin API,
TypeScript with Bun tests, systemd user units.

**Spec:** docs/superpowers/specs/2026-11-12-pantheon-reliability-design.md

## Global Constraints

- All specialists: openai/gpt-6.1-sol-fast; no nested model calls.
- Local implementation/tests only. No server changes, live sends, agent turns,
  plugin activation or timer enablement without separate approval.
- Preserve baseline.patch and seven pre-existing modified files; do not overwrite,
  stage or commit the human's work. No commits/pushes in these writer tasks.
- Asia/Tomsk weekdays07:00; missing07:30; incomplete07:45 or15min after late storage.
- Historical backlog visible, never alerted at initialization; unknown is not sent.
- No vendor edits, new third-party runtime dependencies, website or pixel UI work.
- Native HTTP/CLI success is not recipient device delivery/read.
- Retain existing Seneca formatting-only protocol and runtime model settings.

## Review Focus

1. SSH255 after remote work must not invoke the agent twice (Task1 retry fixture).
2. A late23:xxUTC run must use the Asia/Tomsk logical date (Tasks1/3 clock fixtures).
3. A failed status source must show unavailable, not an empty healthy list (Task3).
4. Alert crash/ambiguous send must not flood Telegram on restart (Task3).
5. Huge placeholder argument objects must not reject valid minimal intent (Task2).

## File structure and shared contract

- Task1 owns `bin/pantheon-state`, `bin/pantheon_ops/__init__.py`,
  `bin/pantheon_ops/state.py`, `bin/pantheon_ops/state_test.py`, existing intake/
  laptop scripts and their tests/service/timer. It may add focused fixtures under
  `bin/fixtures/standup/` and `laptop/fixtures/` only.
- Task2 owns `plugins/pantheon-message-guard/**` (manifest, plugin entry, pure
  validator, Bun tests and plugin-specific README). No server/plugin config edits.
- Task3 owns `bin/pantheon-status`, `bin/pantheon-check`,
  `bin/pantheon_ops/monitor.py`, `bin/pantheon_ops/monitor_test.py`,
  `bin/pantheon_ops/native.py`, `bin/pantheon_ops/native_test.py`,
  `server/pantheon-check.service`, `server/pantheon-check.timer`, and monitor fixtures.
- Task4 owns main README, active persona routing/kin text, deploy workflow and
  installation/check scripts. It does not rewrite historical specs or parked personas.

Shared Task1→Task3 interface:

```python
load_standup(state_dir: Path, day: str) -> dict | None
classify_agent_result(payload: object, exit_code: int) -> dict
```

Stored at `<state_dir>/standups/YYYY-MM-DD/state.json` with version1, `date`,
`attempt_id`, `summary_sha256`, `input:{status,stored_at}`,
`processing:{status,run_id,started_at,finished_at}`,
`delivery:{status,evidence,at}`, `updated_at`. UTC timestamps are ISO8601 strings.
Processing statuses: not_started/accepted/in_flight/succeeded/failed/unknown;
delivery: not_requested/sent/suppressed/partial_failed/failed/unknown.
Missing fields are unknown, not success. `classify_agent_result` returns processing
and delivery objects with exactly these keys/statuses. Task1 may return additional
non-sensitive metadata but must keep these fields stable. `load_standup` validates
the date, version and object shape; malformed state raises a readable typed error,
never appears absent. Monitor converts that error to unavailable/unknown.

Default server state: `/home/openclaw/.local/state/pantheon`, configurable with
`PANTHEON_STATE_DIR`. State directory0700/files0600; lock+atomic replace. Laptop
state uses its own XDG state directory and actual collection timestamps; server
reports unobserved laptop stages honestly. Read-only commands never send/probe.

### Task 1: Durable standup records and safe submission

**Interfaces:** Produces shared state/parser functions above; `pantheon-state`
provides the receipt/locking operations the existing Bash scripts need. The writer
may settle internal CLI verbs, but must document exact commands in its evidence.

- [ ] Write red tests for parser cases: `status=ok` without delivery => processing
  succeeded/delivery unknown; accepted-only => pending; native sent with required
  booleans => sent; malformed/conflicting envelopes => unknown; suppressed/partial/
  failed remain distinct; exit0 alone never sent.
- [ ] Run `python3 -m unittest discover -s bin/pantheon_ops -p 'state_test.py'`;
  record expected pre-implementation failures.
- [ ] Implement state functions, atomic protected writes, per-date locking and
  sanitized metadata in Task1 files. Implement persisted attempt identity/hash,
  duplicate outcome replay, changed-content refusal and explicit resume/resend.
- [ ] Add failing Bash fixtures for SSH255 after acceptance, same hash/no second
  agent call, changed content, concurrent intake, interrupted attempt, resume,
  root/runuser injection seams, invalid dates and legacy file-only state.
- [ ] Update intake/laptop to record truthful independent stages, preserve user
  changes, use Asia/Tomsk dates, persist/resume summary, expose local read-only
  status, and stop claiming delivered based on process exit.
- [ ] Run the Python suite, `bash bin/standup-intake.test.sh` and
  `bash laptop/seneca-standup.test.sh`; all pass with stubs/no real sends.
- [ ] Record files, interface details, red/green commands and limits in
  `.slim/deepwork/pantheon-reliability/lifecycle-evidence.md` (this file is Task1-owned).

### Task 2: Supported message guard (parallel with Task1)

**Interfaces:** Pure `validateMessage(toolName: string, params: unknown)` returns
undefined for allowed calls or `{block:true,blockReason:string}`. Plugin register
binds it to typed `before_tool_call` with normalized `message` matcher.

- [ ] Write red Bun tests for allowed minimal text/poll/pin, invalid Telegram card,
  conflicting/invalid durations, coordinate/accuracy bounds, whitespace location,
  venue pairs, incompatible text/media and unrelated tools/channels unchanged.
- [ ] Run `bun test plugins/pantheon-message-guard`; establish red before code.
- [ ] Implement pure guard and supported version-compatible manifest/entry. Use
  deterministic field-only repair reasons, no raw argument values and no rewrites.
- [ ] Add 101/102-field placeholder fixtures, corrected-input, direct/deferred
  underlying-message registration fixtures, repeated stable veto/zero executor
  calls and mocked thrown-hook boundaries. Test what the plugin owns; do not
  recreate native three-error termination and claim that as a real-host test.
- [ ] Run `bun test plugins/pantheon-message-guard`; pass. Document install,
  compatibility, rollback and the separately approved native-harness gate.
- [ ] Record red/green evidence in
  `.slim/deepwork/pantheon-reliability/guard-evidence.md` (Task2-owned).

### Task 3: Native status, coverage and bounded alerting (after Task1)

**Interfaces:** Consumes Task1 load/record schema. `native.py` runs allowlisted
read commands with argv arrays/timeouts and conservatively normalizes cron/send
JSON. `monitor.py` builds status and checks without importing live state at module
import. CLI `pantheon-status [--json]` is read-only; `pantheon-check --initialize`
only snapshots baseline; ordinary checker may send configured owner alerts.

- [ ] Write red tests for source unavailable, schema drift/malformed records,
  processing versus delivery, historical baseline/no alerts, in-flight transition,
  pagination overlap/retention gaps and configured-agent roster (not directories).
- [ ] Run `python3 -m unittest discover -s bin/pantheon_ops -p '*_test.py'`;
  establish failures for missing monitoring behavior, preserving Task1 tests.
- [ ] Implement read adapter, text/JSON report, bounded pagination and standalone
  monitor state without writing OpenClaw databases. Validate config/date inputs.
- [ ] Add clock-controlled tests at07:29/07:30/07:45, weekends, local/UTC rollover,
  late input+15min, pause dates, missing versus legacy stored-only and suppression.
- [ ] Implement deadline rules and redacted owner-only non-model alerts, no backlog,
  stable dedupe keys, protected pre-dispatch attempt state, safe bounded retries
  only for proven pre-send failure, ambiguous-send suppression and local error state.
- [ ] Test crash/concurrent checker, queued/no-ID/sent/partial/unknown alert result,
  one alert per condition/attempt, no recursive alerting, and status never sends.
- [ ] Add unenabled five-minute user service/timer with explicit state/runtime
  setup. Run complete Python suites and CLI fixture smoke tests, no live OpenClaw.
- [ ] Record commands/results/limitations in
  `.slim/deepwork/pantheon-reliability/monitor-evidence.md` (Task3-owned).

### Task 4: Roster, install paths and final integration

**Interfaces:** Consumes exact executable/install contracts from Tasks1–3.

- [ ] Add regression checks for active Hermes/Zeus/Seneca versus parked templates,
  retained Seneca formatting, minimal message guidance and no unconditional retry.
- [ ] Align active persona references and README facts/setup examples. Follow
  ru-text for modified Russian copy; avoid changing unrelated persona tone.
- [ ] Extend deploy/install checks for new files/tests and document explicit
  baseline initialization, plugin enable/reload, monitor enable and rollback.
  CI does not silently enable the plugin/monitor or mutate live personas.
- [ ] Run all Python/Bun and existing Bash suites, shell syntax, `git diff --check`,
  fixture CLI status/read-only checks and isolated install smoke test.
- [ ] Coordinator inspects each artifact against the approved spec and original
  dirty baseline. Fix concrete defects in the same writer sessions; no unsolicited
  reviewer dispatch outside deepwork. Record native/live checks still open.
- [ ] Update state.md with final evidence and status; report local implementation
  separately from unapproved deployment/native harness/send verification.

## Self-review

All four requested goals map to Tasks1–4. Shared record keys/signatures and scope
ownership are explicit. Review-focus inputs have assigned tests. Historical
failures are context, not a fabricated live baseline. Native validation/receipt
claims remain version-bound; real activation is an open check, not mocked proof.
