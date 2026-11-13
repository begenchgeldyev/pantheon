# AGENTS.md

## What this repository is

This repository holds what OpenClaw does not ship: the gods' persona templates
(`gods/`), the non-owner persona template (`workspace-template/`), the reminder and
standup helpers plus their tests (`bin/`), the reliability checker and status tooling
(`bin/pantheon_ops`), the message-guard plugin, and the laptop half of the standup
(`laptop/`). It is not a service, and it is not deployed except by
`.github/workflows/deploy.yml`. Live agent workspaces live outside the repository.

## Commands

```bash
export TMPDIR=/tmp/opencode PYTHONDONTWRITEBYTECODE=1
python3 -m unittest discover -s bin/pantheon_ops -p '*_test.py'
bun test plugins/pantheon-message-guard
bash bin/remind.test.sh
bash bin/standup-intake.test.sh
bash laptop/seneca-standup.test.sh
bash bin/install-pantheon-helpers.test.sh
for f in bin/install-pantheon-helpers bin/install-pantheon-helpers.test.sh bin/standup-intake laptop/seneca-standup; do bash -n "$f"; done
git diff --check
```

Tests may not touch the native runtime, may not enable units, and may not send anything.
`jq` and `column` (util-linux) are prerequisites.
Bun is used only for the guard plugin tests — the Python helpers and shell scripts are the actual product.

## Rules

- Never copy a file from `gods/` or `workspace-template/` over a live workspace, and never edit a live workspace as a side effect of repo work. Personas are rendered by hand; agents mutate their own workspaces.
- `gods/` is a template, not a deploy source. Directory enumeration is not an agent selector — the configured agents are the roster.
- Installers and packaging stay passive: explicit destinations only, no `systemctl enable`, no `daemon-reload`, no plugin activation, no messages.
- Never claim a send or a reminder was delivered on the strength of a successful call; the honest vocabulary is in `GLOSSARY.md`.
- When a term is coined or renamed, edit `GLOSSARY.md` in the same change. When a decision is hard to reverse, surprising without context, and the result of a real trade-off, add the next numbered file in `docs/adr/`.
- Read `GLOSSARY.md` before using household vocabulary (`god`, `parked`, `hand-off`, `specialist`, `standup`, `intake`) in code, docs or commit messages.
