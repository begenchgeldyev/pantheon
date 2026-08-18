# Containerize Pantheon — Design

**Date:** 2026-08-18
**Status:** Approved

## Goal

Package Pantheon as a Docker container deployed via `docker compose` on the existing VPS, replacing the `pantheon.service` systemd unit. OpenClaw stays on the host; Pantheon's container reaches it via bind-mounted paths and host networking. No functional changes to Pantheon itself.

## Runtime topology

- Single container running on the same VPS that runs OpenClaw.
- Orchestration: `docker compose` (compose file lives in the repo at `/opt/pantheon`).
- `pantheon.service` is retired after cutover.
- Container joins the host network namespace (`network_mode: host`) so `NOTIFY_HOST=127.0.0.1:8477` continues to work unchanged for the OpenClaw cron → Pantheon `/notify` loopback.
- OpenClaw is **not** containerized. Its CLI (`/home/openclaw/.openclaw/bin/openclaw`) and state (`/home/openclaw/.openclaw/`) are bind-mounted into the container at identical paths.

## Image

- Base: `oven/bun:1` (Debian slim). Alpine deferred — glibc keeps `bun:sqlite` and other native bits predictable.
- Multi-stage build:
  - **build stage** — `bun install --frozen-lockfile` against `package.json` + `bun.lock`.
  - **prod stage** — copies `node_modules/`, `src/`, `bin/`, `workspace-template/`, `gods/`, `package.json`, `tsconfig.json` from the build stage. No dev deps.
- Runs as UID/GID `1000:1000` (matches host `openclaw` user).
- Working directory: `/app`.
- Entrypoint: shell script that (1) syncs `remind-impl` scripts to the host bind mount (see below), then (2) execs `bun run src/index.ts`.
- Tags: `pantheon:<git-short-sha>` and `pantheon:latest`. Built on the server (`docker compose build`), no external registry in v1.

## Volumes & filesystem

Four bind mounts:

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `/home/openclaw/.openclaw` | same | `rw` | OpenClaw CLI + agent workspaces. Identical path so `OPENCLAW_BIN` is unchanged. |
| `/opt/pantheon/data` | same | `rw` | SQLite registry (`users.sqlite` + `-wal` + `-shm`). |
| `/opt/pantheon/.env` | same | `ro` | Config file. Stays chmod 600, owned by `openclaw:openclaw` on host. |
| `/home/openclaw/bin` | same | `rw` | Location of `remind-impl/` scripts referenced by host cron via the per-agent wrappers. |

**`remind-impl` handling.** The wrappers installed by `bin/install-remind-wrappers` reference `${REMIND_IMPL_DIR:-/home/openclaw/bin/remind-impl}`. Host cron executes these wrappers, so the impl scripts must exist at that path on the host. The container entrypoint copies `/app/bin/remind-impl/*` to `/home/openclaw/bin/remind-impl/` (via the bind mount) on every start. This keeps the image as the source of truth for those scripts and refreshes them on every deploy.

Nothing writes to `/app` at runtime; the image layer stays effectively read-only.

## Networking

- `network_mode: host` — no bridge, no published ports, no reverse proxy.
- Pantheon binds `NOTIFY_HOST=127.0.0.1 NOTIFY_PORT=8477` exactly as today.
- OpenClaw cron POSTs to `127.0.0.1:8477` unchanged.
- Telegram traffic is outbound long-polling; no inbound exposure required.
- VPS firewall unchanged.
- Trade-off: host networking forfeits network namespace isolation. Acceptable for a single-tenant VPS where Pantheon and OpenClaw already share the host.

## Config & secrets

- `.env` continues to live at `/opt/pantheon/.env`, chmod 600, owned by `openclaw:openclaw`. Bind-mounted read-only.
- Compose uses `env_file: /opt/pantheon/.env` — one file, no duplication.
- No secrets in the image, in the compose file, or in git. `.env` is already gitignored.
- `TZ` explicitly set (e.g. `TZ=Asia/Almaty`) so reminder timestamps match host cron.
- Future secrets manager swap point: replace `env_file:` with the manager's env source. No code changes.

## Logging

- Pantheon writes structured JSON to stdout (already implemented).
- Compose sets `logging.driver: journald` with `tag: pantheon`.
- Logs land in the systemd journal exactly as today; `journalctl -t pantheon -f` continues to work.
- No log files inside the container. No log rotation to configure.

## Deploy workflow

On the VPS:

1. `cd /opt/pantheon && git pull`
2. `docker compose build` (fast after first build thanks to `bun.lock` layer cache)
3. `docker compose up -d` (recreates container if the image changed)
4. Verify: `journalctl -t pantheon -f` and a Telegram round-trip

Rollback: `git checkout <prev-sha> && docker compose up -d --build`.

## First-time cutover

1. `sudo systemctl stop pantheon && sudo systemctl disable pantheon`
2. Remove `/etc/systemd/system/pantheon.service` (keep the file in the repo for reference, or delete — operator's choice).
3. `docker compose up -d`
4. Verify:
   - Telegram round-trip works.
   - A scheduled reminder fires and reaches Telegram (exercises host cron → `/notify` → grammY).
   - SQLite registry file `/opt/pantheon/data/users.sqlite` continues to be read/written.

No changes to OpenClaw, no changes to `.env`, no changes to `~/.openclaw` layout.

## Out of scope / follow-ups

Explicitly not part of this spec:

- **Remove voice-reply / Piper code paths.** The Piper binary is already removed from the server; keep Groq Whisper transcription of incoming voice notes. Separate PR after containerization lands.
- **Container registry / multi-host deploys.** Deferred until there is more than one VPS.
- **Healthcheck endpoint.** No `/health` route today; Docker's default process-liveness check suffices.
- **Non-root hardening beyond UID 1000.** No `read_only: true`, no `cap_drop`, no seccomp profile in v1. Revisit once baseline is stable.
- **Containerizing OpenClaw.** Separate project.
- **CI-built images.** Deploys stay manual (`git pull && docker compose up -d --build`) in v1.
