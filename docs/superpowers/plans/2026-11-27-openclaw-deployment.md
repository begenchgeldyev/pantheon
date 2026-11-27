# OpenClaw Deployment Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution. Steps use checkbox syntax for tracking.

**Goal:** Extend Pantheon's existing OpenClaw integration into a reproducible, passive fresh-host deployment.

**Architecture:** A verified upstream runtime bundle and disabled-by-default service templates are independent of state. Recovery takes an already consistent snapshot as input and verifies restored SQLite state offline. Public CI does not deploy; production activation remains an operator action.

**Tech Stack:** Ubuntu 24.04 x86-64, Python 3.12, systemd, SQLite, restic, upstream OpenClaw and CLIProxyAPI.

**Spec:** The approved Wayfinder decisions (kept in the original checkout), summarized in `docs/openclaw-recovery.md`.

## Global Constraints

- OpenClaw `2026.10.10`, Node `24.21.0`, CLIProxyAPI `8.0.41`. Gateway and proxy use loopback only, on ports `18789` and `8317` respectively.
- Git contains no live config, credentials, backup payloads, or private workspaces. Preserve existing integration code and the original working tree.
- Daily and pre-upgrade encrypted off-server backups; retain 7 daily and 4 weekly snapshots. Production activation requires a real isolated rehearsal and separate authorization.

## Review Focus

- A corrupted upstream download must not produce a runtime bundle.
- A rerun must not replace an existing installation or live state.
- A state snapshot missing a required database or containing an unsafe path must fail closed.
- Pending SQLite commits must be visible to verification; corrupted stores must fail.
- CI must have no push-to-production path or deployment credentials.

## Task 1: Passive runtime packaging

- [x] Write `tests/deployment_test.py` fixture tests for checksum, archive handling, and existing bundle refusal; run red.
- [x] Add `deploy/runtime.py`: `verify_artifact(path, digest)` and `stage(artifacts, destination)` with pinned inputs in `deploy/releases.json`; publish a bundle only when the complete install succeeds. Include service and safe configuration templates.
- [x] Run the fixture suite and install the real pinned artifacts into a disposable local directory without starting the native services.

## Task 2: Recovery verification

- [x] Add synthetic SQLite fixture tests for WAL visibility, corrupt or missing databases, and manifest drift; run red.
- [x] Add `deploy/recovery.py` for private manifests and `deploy/backup.py` to encrypt, restore and monitor an already consistent snapshot. Document off-server backup and rehearsal in `docs/openclaw-recovery.md`.
- [x] Run the synthetic tests, including an encrypted restic round trip and a stale capture. Do not claim live recovery without a verified snapshot, configured vault, and fresh rehearsal host.

## Task 3: CI and handoff

- [x] Retain the current repository checks, add deployment fixtures, and remove automatic SSH deployment from the branch.
- [x] Verify both suites, finalize the runbook, and review the branch before publication. Review follow-ups cover restic's incomplete snapshot behavior and user-service reboot recovery.

## External gates

- [x] Disable the GitHub legacy workflow and verify all runs are terminal.
- [x] Mark `7909594084fa0e7a80c71461df5dc1690af27332`, the last bot commit, with the annotated `pantheon-legacy` tag.
- [ ] Capture production state consistently; send it to the approved encrypted off-host vault. Prove daily freshness, retention and operator alerts.
- [ ] Privately verify both proxy mappings and the reviewed custom dependency set; restore and rehearse on a fresh host with scoped test identities and no production egress.
- [ ] Authorize any subsequent production activation separately.
