# Glossary

Pantheon's own vocabulary. OpenClaw's product terms (agent, session, workspace,
tool policy) keep their upstream meaning and are not redefined here.

## Routing and household

**God**:
A persona-defined agent of the owner's household, whose templates live in `gods/<id>/`. Hermes is a god with no `gods/` directory of its own.
_Avoid_: bot, character

**Household** (also **roster**):
The configured live set of owner agents — Hermes (`main`), Zeus, Seneca. It is what the configured bindings report, never the contents of `gods/`.
_Avoid_: gods directory, template set, agent list

**Specialist**:
Hermes or Seneca as seen from Zeus's routing role: a target he hands work to. Zeus himself is never a specialist.
_Avoid_: subagent, worker, child agent

**Parked**:
A persona, with its retained history, for an agent that is not configured and is not a hand-off target (Athena, Heracles, Aphrodite).
_Avoid_: disabled, inactive, archived, removed

**Persona** (also **template**):
The Markdown files under `gods/<id>/` or `workspace-template/` that get rendered with placeholders into an agent's workspace. It is source material for a workspace, not runtime configuration.
_Avoid_: prompt, config, system prompt

**Binding**:
A config entry that maps one channel peer to one `agentId`. It is not admission: `allowFrom` lets a user in, a binding decides which agent answers them.
_Avoid_: route, allowlist entry, connection

**Hand-off**:
Zeus sending the owner's verbatim words to a specialist through `sessions_send` into `agent:<id>:main`. Word between two specialists is the same one-hop call, not a second kind of hand-off.
_Avoid_: delegation, transfer, tell

**`NO_REPLY`**:
The silence token that ends a turn so no answering turn is generated. `REPLY_SKIP`, `ANNOUNCE_SKIP` and `HEARTBEAT_OK` belong to the same family.
_Avoid_: silence mode, empty message, ack

**Ping-pong cap**:
OpenClaw's native limit of five extra agent turns plus one announce turn per exchange. Pantheon has no loop guard or rate cap of its own.
_Avoid_: loop guard, rate cap, turn budget

**`agent:<id>:main`**:
The session key Zeus writes to. The `:main` suffix names a session; the agent id is the part before it.
_Avoid_: main agent key, default session, agent name

**`u_<id>`**:
An isolated agent for a non-owner user, named after that user's numeric Telegram id. It can neither reach nor be reached by the owner's gods.
_Avoid_: guest agent, user god

## Reminders

**Wrapper** vs **impl**:
The per-agent script that pins one agent id and execs the real helper; `bin/remind-impl/remind*` are those real helpers, which take the agent id as their first argument.
_Avoid_: shim, alias, remind script (for either half)

**Exec allowlist**:
The per-agent policy naming the exact paths an agent may exec. It is the attribution primitive: a wrapper's hard-coded id is unforgeable only because that path alone is gated.
_Avoid_: exec policy, approval, sandbox

**owner-chat**:
The file holding the owner's numeric Telegram id, read by the reminder helpers to address a god's reminder. It is provisioned by hand; no installer creates or overwrites it.
_Avoid_: chat id file, target file

## Standup

**Standup**:
Seneca's weekday-morning work summary, collected on the owner's laptop and delivered on the server. The word names the whole pipeline, not the Markdown artifact it produces.
_Avoid_: report, summary file, daily

**Intake**:
`bin/standup-intake`, the server-side entry point that validates, stores and dispatches the laptop's submission. It is the only route by which a standup starts reaching the owner.
_Avoid_: receiver, endpoint, webhook

**Stage**:
The durable per-date lifecycle position: started, collected, generated, submitting, submitted, submission_unknown, failed. It describes progress toward submission, never delivery.
_Avoid_: state, status, phase

**Attempt** (also **receipt**):
The per-date record of one submission — input hash, attempt identity, and stage timestamps — recorded before the native call and settled after it. It proves a submission was attempted, not that anything was delivered.
_Avoid_: run, job, delivery record

## Reliability

**Status** vs **check**:
`pantheon-status` only reports; `pantheon-check` is the separately activated checker that may send owner-only alerts.
_Avoid_: health check, doctor, monitor (for either)

**Baseline** (`--initialize`):
The one-time snapshot of completed native history taken at activation, so pre-existing failures never alert. There is no second initialization; a repeated run refuses to reset dedupe.
_Avoid_: reset, snapshot, first run

**Monitored / expected / due**:
A day is monitored only from the baseline date onward; expected means a monitored weekday that is not excluded or paused; due means an expected day whose 07:30 input deadline has passed in Asia/Tomsk.
_Avoid_: scheduled, overdue, missed

**Gap**:
A source range the tooling could not read, reported as a gap instead of being counted as healthy or complete. Gaps stay visible and can make the exit status non-zero.
_Avoid_: missing, error, unknown

**Dispatch**:
One alert send attempt whose intent is persisted before the message leaves, capped at five per check. It is the unit of alerting, not the condition that caused it.
_Avoid_: alert, notification, send

**Sent** vs **delivered**:
`sent` is platform acknowledgement of a send and nothing more. Delivery also carries `suppressed`, `partial_failed`, `failed`, `not_requested` and `unknown`, so sent never means the owner saw it.
_Avoid_: delivered (as a synonym for sent), success

## Operations

**Passive install**:
Copying production files to explicit destinations without reloading, enabling, activating or sending anything. Activation is always a separate, approved step.
_Avoid_: deploy, provision, setup

**Guard**:
`pantheon-message-guard`, the `before_tool_call` blocker that refuses a call with a fixed reason. It never rewrites arguments and never logs payloads.
_Avoid_: filter, sanitizer, middleware, proxy

## Naming hazards

- `main` is the agent id of Hermes, not the git branch; the deploy workflow also fires on a branch named `main`. Say which one you mean.
- `workspace-template/` is the persona for a *non-owner* user's agent, not Hermes and not the owner's live workspace. Its current header still says Hermes (issue #3).
- `god` is the household role, even though `gods/seneca/IDENTITY.md` calls Seneca mortal; the directory marks the role, not a claim of divinity (issue #4).
- `submitted` (a stage) and `sent` (a delivery status) are different receipts; neither proves the owner read anything.
