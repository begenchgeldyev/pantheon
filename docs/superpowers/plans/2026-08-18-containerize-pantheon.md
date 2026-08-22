# Containerize Pantheon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Pantheon as a Docker container deployed via `docker compose`, replacing the `pantheon.service` systemd unit while keeping OpenClaw on the host.

**Architecture:** Single container running from a multi-stage `oven/bun:1` image. `network_mode: host` so `NOTIFY_HOST=127.0.0.1:8477` and the OpenClaw cron loopback keep working unchanged. Bind mounts for `/home/openclaw/.openclaw`, `/opt/pantheon/data`, `/opt/pantheon/.env`, and `/home/openclaw/bin` (for `remind-impl` scripts host cron needs). Container runs as UID/GID 1000.

**Tech Stack:** Docker, Docker Compose, Bun 1.x, systemd (journald log driver).

**Spec:** `docs/superpowers/specs/2026-08-18-containerize-pantheon-design.md`

---

## File Structure

Files created in this plan (all at repo root unless noted):

| File | Responsibility |
|---|---|
| `Dockerfile` | Multi-stage build producing the runtime image. |
| `.dockerignore` | Keep build context small; exclude `node_modules`, `.git`, `data/`, `.env*`. |
| `docker/entrypoint.sh` | Sync `bin/remind-impl/` to the host bind mount, then exec Bun. |
| `docker-compose.yml` | Service definition: bind mounts, `network_mode: host`, `env_file`, `journald` logging, UID 1000. |
| `README.md` | Update deploy section to point at the container workflow. |
| `pantheon.service` | Keep the file in-repo for reference; add a deprecation note at the top. |

No source code under `src/` changes.

---

### Task 1: Add `.dockerignore`

**Files:**
- Create: `.dockerignore`

- [ ] **Step 1: Create `.dockerignore`**

```gitignore
# VCS
.git
.gitignore

# Local runtime data — never bake into image
data/
.env
.env.*
!.env.example

# Node/Bun
node_modules
bun.lockb

# Editor / OS
.vscode
.idea
.DS_Store

# Docs / plans — not needed at runtime
docs/

# Systemd unit — not needed inside container
pantheon.service
```

- [ ] **Step 2: Commit**

```bash
git add .dockerignore
git commit -m "chore: add .dockerignore for container build"
```

---

### Task 2: Add container entrypoint script

**Files:**
- Create: `docker/entrypoint.sh`

The entrypoint syncs `remind-impl` scripts from the image into the `/home/openclaw/bin` bind mount so host cron can execute them via the wrappers Pantheon installs into agent workspaces. Then it execs Pantheon.

- [ ] **Step 1: Create `docker/entrypoint.sh`**

```bash
#!/bin/sh
# Container entrypoint for Pantheon.
#
# 1. Sync the remind-impl scripts baked into the image onto the host bind
#    mount (/home/openclaw/bin/remind-impl). Host cron executes these via the
#    per-agent wrappers Pantheon installs into agent workspaces, so they MUST
#    exist at a path visible from the host.
# 2. Exec Bun to run Pantheon (PID 1, receives SIGTERM directly).
set -eu

IMPL_SRC="/app/bin/remind-impl"
IMPL_DST="/home/openclaw/bin/remind-impl"

if [ -d "$IMPL_SRC" ]; then
  mkdir -p "$IMPL_DST"
  cp -a "$IMPL_SRC"/. "$IMPL_DST"/
fi

exec bun run src/index.ts
```

- [ ] **Step 2: Make it executable and commit**

```bash
chmod +x docker/entrypoint.sh
git add docker/entrypoint.sh
git commit -m "feat(container): entrypoint syncs remind-impl to host bind mount"
```

---

### Task 3: Add multi-stage `Dockerfile`

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7

# --- Build stage: install deps against the frozen lockfile ---
FROM oven/bun:1 AS build

WORKDIR /app

# Copy manifest + lockfile first for layer cache.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy the rest of the source needed at runtime.
COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
COPY workspace-template ./workspace-template
COPY gods ./gods

# --- Prod stage: minimal runtime ---
FROM oven/bun:1 AS prod

# Run as the same UID/GID as the host `openclaw` user so bind-mounted paths
# (~/.openclaw, /opt/pantheon/data) are writable without permission gymnastics.
ARG UID=1000
ARG GID=1000

WORKDIR /app

# Copy the built artifact from the build stage.
COPY --from=build --chown=${UID}:${GID} /app /app

# Entrypoint script (owned by root, executable, runs as UID 1000).
COPY --chown=root:root docker/entrypoint.sh /usr/local/bin/pantheon-entrypoint
RUN chmod 755 /usr/local/bin/pantheon-entrypoint

USER ${UID}:${GID}

ENTRYPOINT ["/usr/local/bin/pantheon-entrypoint"]
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "feat(container): multi-stage Dockerfile on oven/bun:1"
```

---

### Task 4: Add `docker-compose.yml`

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
services:
  pantheon:
    build:
      context: .
      dockerfile: Dockerfile
    image: pantheon:latest
    container_name: pantheon
    restart: unless-stopped

    # Host networking: preserves NOTIFY_HOST=127.0.0.1 loopback from OpenClaw
    # cron to Pantheon's /notify endpoint with zero config change.
    network_mode: host

    # Load the same .env file the systemd unit used. Kept on host, chmod 600,
    # owned by openclaw:openclaw. Bind-mounted read-only below as well so
    # anything that Reads the file at runtime keeps working.
    env_file:
      - /opt/pantheon/.env

    environment:
      # Match host cron timezone so reminder timestamps line up.
      TZ: Asia/Almaty

    volumes:
      # OpenClaw CLI + agent workspaces. Identical container path so
      # OPENCLAW_BIN=/home/openclaw/.openclaw/bin/openclaw is unchanged.
      - /home/openclaw/.openclaw:/home/openclaw/.openclaw

      # Pantheon's SQLite registry (users.sqlite + wal + shm).
      - /opt/pantheon/data:/opt/pantheon/data

      # Config file. Read-only bind mount; env_file above already loaded it.
      - /opt/pantheon/.env:/opt/pantheon/.env:ro

      # remind-impl scripts land here at container start (via entrypoint)
      # so host cron can execute them through the per-agent wrappers.
      - /home/openclaw/bin:/home/openclaw/bin

    logging:
      driver: journald
      options:
        tag: pantheon
```

- [ ] **Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(container): docker-compose service definition"
```

---

### Task 5: Mark `pantheon.service` as deprecated (keep for reference)

**Files:**
- Modify: `pantheon.service` (prepend a header)

- [ ] **Step 1: Prepend deprecation notice**

Prepend this block to the top of `pantheon.service` (before `[Unit]`):

```ini
# DEPRECATED as of 2026-08-18.
#
# Pantheon now runs as a Docker container managed by docker compose.
# See docker-compose.yml at the repo root and the deploy section of README.md.
#
# This unit file is kept in-repo for reference only. It is NOT installed by the
# containerized deploy. If it is still enabled on a host, disable it before
# starting the container to avoid two Pantheon instances contending for the
# Telegram bot token:
#     sudo systemctl stop pantheon
#     sudo systemctl disable pantheon
#     sudo rm /etc/systemd/system/pantheon.service
#     sudo systemctl daemon-reload
```

- [ ] **Step 2: Commit**

```bash
git add pantheon.service
git commit -m "docs: mark pantheon.service as deprecated in favor of docker compose"
```

---

### Task 6: Update `README.md` deploy section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the current install/deploy sections**

Open `README.md` and locate the sections titled "Install" (§3), "Configure" (§4), and any systemd/service instructions further down. Replace the systemd-based deploy content with the container workflow.

- [ ] **Step 2: Replace systemd deploy section with container deploy**

Replace the systemd unit installation block with:

````markdown
## Deploy (Docker Compose)

Pantheon runs as a single Docker container on the same VPS as OpenClaw.
OpenClaw itself is **not** containerized — its CLI and state directory are
bind-mounted into the container.

### Prerequisites

- Docker Engine 24+ and the compose plugin (`docker compose version`).
- The `openclaw` user on the host with UID/GID 1000.
- `/opt/pantheon/.env` populated (chmod 600, owned by `openclaw:openclaw`).
- `/opt/pantheon/data/` exists and is writable by UID 1000 (holds `users.sqlite`).

### First-time cutover from systemd

```bash
sudo systemctl stop pantheon
sudo systemctl disable pantheon
sudo rm /etc/systemd/system/pantheon.service
sudo systemctl daemon-reload
```

### Build and start

```bash
cd /opt/pantheon
git pull
docker compose build
docker compose up -d
```

### Verify

```bash
docker compose ps                 # container should be "running"
journalctl -t pantheon -f         # structured JSON logs
```

Then send a message to the bot on Telegram and confirm a scheduled reminder
fires (exercises host cron → `/notify` → grammY).

### Update

```bash
cd /opt/pantheon
git pull
docker compose up -d --build
```

### Rollback

```bash
cd /opt/pantheon
git checkout <previous-sha>
docker compose up -d --build
```

### Filesystem layout

| Host path | Purpose |
|---|---|
| `/opt/pantheon` | Repo checkout (compose file, Dockerfile, source). |
| `/opt/pantheon/.env` | Config; bind-mounted read-only into the container. |
| `/opt/pantheon/data/` | SQLite registry (`users.sqlite` + wal + shm). |
| `/home/openclaw/.openclaw/` | OpenClaw CLI + agent workspaces; bind-mounted rw. |
| `/home/openclaw/bin/remind-impl/` | Reminder impl scripts; refreshed by the container entrypoint on every start so host cron sees the latest version. |
````

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: replace systemd deploy instructions with docker compose"
```

---

### Task 7: Local build smoke test

**Files:** none

- [ ] **Step 1: Build the image locally**

Run: `docker compose build`
Expected: build succeeds, final image tagged `pantheon:latest`. First build downloads `oven/bun:1`; subsequent builds hit the layer cache on `bun.lock`.

- [ ] **Step 2: Inspect the image**

Run: `docker image inspect pantheon:latest --format '{{.Config.User}} {{.Config.Entrypoint}}'`
Expected: `1000:1000 [/usr/local/bin/pantheon-entrypoint]`

- [ ] **Step 3: Verify entrypoint is executable inside the image**

Run: `docker run --rm --entrypoint sh pantheon:latest -c 'ls -la /usr/local/bin/pantheon-entrypoint && ls /app/bin/remind-impl'`
Expected: entrypoint is `-rwxr-xr-x`; `/app/bin/remind-impl/` lists the impl scripts.

- [ ] **Step 4: No commit needed (verification only)**

---

### Task 8: Deploy to the VPS

**Files:** none (server-side actions)

These steps run on the VPS via `ssh kz-openclaw`.

- [ ] **Step 1: Confirm Docker is installed on the host**

Run: `ssh kz-openclaw 'docker --version && docker compose version'`
Expected: both commands report versions. If Docker isn't installed, stop and install it before continuing.

- [ ] **Step 2: Confirm the openclaw user has permission to run Docker**

Run: `ssh kz-openclaw 'docker ps'`
Expected: no permission error. If it errors, add openclaw to the `docker` group (`sudo usermod -aG docker openclaw`) and reconnect.

- [ ] **Step 3: Pull the branch on the server**

Run: `ssh kz-openclaw 'cd /opt/pantheon && git fetch && git checkout feature/containerize && git pull'`
Expected: working tree at the tip of `feature/containerize`.

- [ ] **Step 4: Stop and disable the systemd unit**

Run: `ssh kz-openclaw 'sudo systemctl stop pantheon && sudo systemctl disable pantheon'`
Expected: unit stopped and disabled. Verify: `sudo systemctl status pantheon` shows `inactive (dead)`.

- [ ] **Step 5: Confirm `.env` and data dir permissions**

Run: `ssh kz-openclaw 'ls -la /opt/pantheon/.env /opt/pantheon/data/'`
Expected: `.env` is `-rw------- openclaw openclaw`; `data/` is owned by `openclaw:openclaw` and writable.

- [ ] **Step 6: Build and start the container**

Run: `ssh kz-openclaw 'cd /opt/pantheon && docker compose build && docker compose up -d'`
Expected: build succeeds, container `pantheon` is `Up`.

- [ ] **Step 7: Watch logs for a clean startup**

Run: `ssh kz-openclaw 'journalctl -t pantheon -f'`
Expected: structured JSON lines showing config loaded, grammY polling started, notify server listening on `127.0.0.1:8477`. Ctrl-C after ~10 seconds.

- [ ] **Step 8: Confirm the notify port is bound**

Run: `ssh kz-openclaw 'ss -tlnp | grep 8477'`
Expected: `bun` process listening on `127.0.0.1:8477`.

- [ ] **Step 9: Confirm `remind-impl` scripts were synced to the host**

Run: `ssh kz-openclaw 'ls /home/openclaw/bin/remind-impl/'`
Expected: `remind`, `remind-in`, `remind-cron`, `remind-list`, `remind-rm` all present, mtime within the last few minutes.

- [ ] **Step 10: End-to-end Telegram round-trip**

From your Telegram client, send any message to the bot.
Expected: reply arrives; `journalctl -t pantheon -n 50` shows the turn being routed through the correct agent.

- [ ] **Step 11: End-to-end reminder round-trip**

From your Telegram client, ask the bot to remind you of something in ~2 minutes ("remind me in 2 minutes to test the container").
Expected: after ~2 minutes, the reminder message arrives in the chat. This exercises the OpenClaw cron on the host → the per-agent wrapper → the impl script in `/home/openclaw/bin/remind-impl/` → HTTP POST to `127.0.0.1:8477/notify` → grammY → Telegram.

- [ ] **Step 12: No commit needed (verification only)**

---

### Task 9: Merge `feature/containerize` to `main`

**Files:** none

- [ ] **Step 1: Verify all previous tasks are complete**

Run locally: `git log --oneline main..feature/containerize`
Expected: commits from tasks 1–6 present.

- [ ] **Step 2: Merge and push**

```bash
git checkout main
git merge --no-ff feature/containerize -m "feat: containerize Pantheon"
git push origin main
```

- [ ] **Step 3: Update the server checkout to main**

Run: `ssh kz-openclaw 'cd /opt/pantheon && git checkout main && git pull && docker compose up -d'`
Expected: server on `main`, container still running (no rebuild needed unless source changed since Task 8).

---

## Follow-ups (tracked separately, not in this plan)

- Remove Piper/voice-reply code paths from the repo (binary already removed from server; keep Groq Whisper transcription).
- Consider a `/health` endpoint if container restart loops become a concern.
- Consider a container registry once there is more than one host.
