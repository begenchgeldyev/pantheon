# Pantheon message guard

Standalone, dependency-free policy plugin targeting the inspected OpenClaw
2026.10.10 contracts. Not installed or activated by this repository's tests.
Newer versions require compatibility checks; the metadata floor is not a claim
that every future release has been tested.

`validateMessage(toolName, params)` returns `undefined` or a deterministic
`{block:true, blockReason}`. It never rewrites arguments, logs payloads, invokes an
executor, or counts retries. Reasons contain only fixed field names/instructions.
The structural default entry is supported by `OpenClawPluginDefinition`; SDK
imports are type-only, so Bun tests do not need an installed OpenClaw SDK runtime.
The manifest supplies the empty config schema and startup activation declaration;
`package.json` declares the local TypeScript entry.

## Policy boundary

- Typed `api.on("before_tool_call", ...)`, matcher `["message"]` (normalized
  underlying tool). No observation-only hook or `dispatch_action` argument parser.
- Explicit Telegram `action: "send"`: reject nonempty `clawhub`, invalid location
  coordinates/accuracy/text, unsupported location fields, incomplete venue pairs,
  and location combined with actual text/media/video notes.
- Telegram `action: "poll"`: finite positive integer `pollDurationSeconds` or
  `pollDurationHours`, not both. The supported `durationSeconds` and `durationHours`
  primary aliases take precedence over their poll-prefixed fallbacks. Selected
  cross-alias seconds/hours combinations are also rejected; an ignored fallback
  is not separately validated. Null and blank duration fields are omitted, so
  primary placeholders permit fallback; zero remains invalid, not omitted.
  No duration maximum is invented. Other-channel polls retain the documented shared
  finite-number/floor/minimum/conflict checks, not Telegram's integer restriction.
- Other tools/actions/channels are left to the host. Telegram detection requires
  explicit `channel: "telegram"`; an omitted/inferred route is not certified by
  this plugin. Use explicit channels in guarded construction. Channel/underlying
  tool names are trimmed/lowercased; action names are the host's exact names.
- Irrelevant duration defaults do not invalidate text/pin actions. Null location,
  null/empty-string `clawhub`, empty media and false video-note defaults do not
  create payload intent. Explicit malformed location objects still require repair.
  Synthetic 101/102-field fixtures are not historical payload reproductions or
  proof of a provider/schema adapter cause.

Telegram `clawhub` rejection is a deliberate deployment policy. Current native
external-route code may discard the card instead of reproducing historical errors.
This is not a replacement for the host's evolving schema or platform validation.

## Installation / enable / reload (operator only)

Do not perform these steps until the isolated native-harness gate below is
separately approved and passes. Back up Gateway configuration first and inspect
the installed version's `openclaw plugins --help` and install/enable/disable help.

1. Copy this entire plugin directory to a protected, host-readable local directory
   (include `index.ts`, `validator.ts`, both JSON files; no dependency install or
   build is needed). Avoid writable-by-untrusted-user plugin paths.
2. Install that local directory using the supported host CLI, e.g.
   `openclaw plugins install /absolute/path/pantheon-message-guard`. Installation
   may update configuration; inspect the resulting enabled/trust/allowlist state
   before continuing. Do not download a similarly named registry package.
3. Explicitly enable `pantheon-message-guard` with the host's plugin enable command
   and add its ID to an existing plugin allowlist if required. Preserve all other
   plugin entries. There are no plugin configuration fields.
4. Arrange a controlled Gateway restart/reload using the deployment's documented
   service procedure; verify native plugin discovery and typed hook registration
   before allowing traffic. Tests here do not establish that a reload occurred.

Rollback: disable `pantheon-message-guard` with the host CLI, restore the previous
trust/load configuration if changed, and perform the same controlled Gateway
restart/reload. Verify it is no longer loaded before deleting its installed copy.
Rollback removes enforcement; prompt guidance alone is not an equivalent guard.

## Local checks and mandatory native harness gate

Run `bun test plugins/pantheon-message-guard` from the repository. Tests execute
the real validator and registered callback, with a test-only caller/executor
double. Direct/deferred fixtures assume the host has resolved the underlying
`message`; they do not test native catalog resolution. A throwing-input fixture
confirms exceptions propagate rather than becoming an allow result; the host's
fail-closed dispatcher and generic error text remain source-backed, not exercised.

Before live activation, obtain approval for an isolated host harness with no real
Telegram delivery or personal agent/model turns. Verify actual manifest/entry
loading, matcher eligibility, direct and deferred normalized message enforcement,
model-visible stable veto with zero executor effects, repaired input proceeding,
and thrown-hook fail-closed handling. Verify native loop integration separately:
the installed native detector stops after **three consecutive matching errors**;
the plugin does not terminate a run immediately and owns no global retry counter.
Do not substitute a mock detector for that native verification. Real Telegram
acceptance is a separate approval/check and never proves recipient display/read.
