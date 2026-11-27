# OpenClaw recovery runbook

**Gate:** Git, an encrypted off-host recovery capture and separate credentials are all required. Passing the repository fixtures is not a recovery rehearsal. Do not enable production channels or automations from this runbook.

## 1. Stage a fresh host

Use a dedicated Ubuntu 24.04 x86-64 host with systemd, Python 3.12, `curl`, `restic`, `jq` and `column` (provided by `bsdextrautils` on Ubuntu). Use an unprivileged build account, an `openclaw` account with home `/home/openclaw`, and a separate non-login `cliproxyapi` service account. The website stack is not a dependency. The service units expect a root-owned runtime at `/opt/pantheon/runtime`, separate from the restored state.

From a clean checkout, stage in a new absolute directory with an existing parent. npm needs registry access to resolve and install dependencies. The three release archives are checksum-pinned; the npm transitive tree is not lockfile-pinned. Keep the staged bundle securely if exact dependency replay is required.

```bash
artifacts=$(mktemp -d)
bundle="$artifacts/runtime"
while IFS=$'\t' read -r file url; do
  curl --fail --silent --show-error --location "${url}" --output "$artifacts/$file" || exit 1
done < <(jq -r '.[] | [.file, .url] | @tsv' deploy/releases.json)
python3 deploy/runtime.py "$artifacts" "$bundle"
PATH="$bundle/node/bin:$PATH" "$bundle/node/bin/openclaw" --version
```

Stage as an unprivileged user; upstream npm lifecycle scripts can execute during this step. Inspect the result before copying it to the root-controlled `/opt/pantheon/runtime`. Refuse to replace an existing runtime, unit, environment file or state directory: compare it to the intended copy first, and stage a new version separately for a planned upgrade. Add `deploy/cliproxyapi.service` under `/etc/systemd/system/` and `deploy/openclaw-gateway.service` under `/home/openclaw/.config/systemd/user/`. Unit installation is passive. The optional `bin/install-pantheon-helpers` copies repository helpers to explicit destinations; it is not an installer for live config, custom extensions or per-agent wrappers. Some existing helpers expect `openclaw` in `/usr/local/bin`; provide a reviewed executable wrapper there with the pinned Node on its PATH before explicitly opting into those helpers.

Install no host cron entries, helper timers, restart timers or plugins for the initial rehearsal. Verify the preset unit names are not enabled and that no inherited unit drop-ins or external schedulers can activate them. Never populate recovered workspaces from the persona templates.

## 2. Prepare a consistent recovery capture

Create the capture on a trusted off-server machine with enough space and restricted storage. Do not stage a full copy on the source host. Do not tar or rsync a live state tree and call it consistent: committed transactions can still be in WAL, and workspace files can change separately from the database. Use a verified point-in-time snapshot covering **all** state paths, or get approval for a maintenance window, stop every writer for the full copy (including external timers and scripts), and confirm they stay stopped. No online, cross-file snapshot method has been verified for the current source filesystem. Do not stop any services just to test this procedure.

Preserve all configured and unconfigured agent directories, all workspaces, memory, sessions, job definitions and saved enabled states, and other state required by those records (including any referenced paths outside the default tree). A private credential-free config inventory must preserve the configured roster, bindings, enabled flags and integration dependencies; keep it in the capture. Copy SQLite databases and their `-wal`/`-journal` sidecars from the same point in time. SQLite `-shm` indexes are transient and omitted. Never substitute old backups, caches, installed binaries, dependencies, environment files, Telegram token files, gateway keys, proxy auth stores or secret-store exports for required state. Review symlinks and external dependencies explicitly; the verifier rejects symlinks and special files rather than dereferencing them. Private config and session text may still contain secrets even after direct credential sources are excluded.

Compare the source and captured inventories privately: all agent IDs and workspace roots, required databases and recorded session and job counts from that same point, and the job enabled states. The manifest verifies the contents it receives, not whether the operator captured every source path. If an expected item is missing, do not publish the backup. Keep a private note of the capture time and method; a newly uploaded copy of yesterday's capture does not meet a freshness target.

With the capture stable and private (`0700` staging directory), lay it out as `capture/state/` and `capture/manifest.json`. Run commands as the non-root backup operator, with restic using an off-server backend and a mode-`0600` password file supplied from the separate secret store. Initialize a **dedicated** encrypted repository once. Do not use a repository under the source host, this checkout or a workspace. Any SSH staging must go only to that approved backup operator and host.

```bash
python3 deploy/recovery.py manifest /secure/capture/state /secure/capture/manifest.json
python3 deploy/backup.py backup primary /secure/capture --captured-at "$CAPTURED_AT_ISO8601"
python3 deploy/backup.py check primary
python3 deploy/backup.py retention-preview primary
```

Supply the actual point-in-time capture date with a timezone, not the upload time. On the backup host, schedule **a new consistent capture and backup** daily and before upgrades. Send a non-zero backup result to the existing operator alert route without private logs. From an independent monitor run `backup.py check primary` at least hourly; it fails on an inaccessible vault or no stored capture dated within 24 hours. Confirm receipt of a synthetic missed/failed-backup alert before relying on the schedule. Preview retention before running `backup.py retain primary` (seven daily and four weekly buckets, which can overlap). Schedule restic pruning separately according to the backend policy; the retention command forgets snapshots but does not reclaim their storage. Periodically run `restic check`. No timers, vault or alert route are configured by this repo.

## 3. Restore and rehearse in isolation

Set a deny-by-default outbound network policy on the rehearsal host before the first start. Allow only explicitly approved prerequisites and test-provider destinations when needed; deny Telegram and other production integration destinations. Confirm from the rehearsal host that these boundaries hold and that neither service can reach the old server. Keep the live host serving production throughout.

```bash
python3 deploy/backup.py snapshots primary
python3 deploy/backup.py restore "$FULL_SNAPSHOT_ID" /secure/recovered
python3 deploy/recovery.py verify /secure/recovered/state /secure/recovered/manifest.json
```

The restore goes to a new directory, verifies restored bytes and permissions plus SQLite integrity and key table counts, and refuses to overwrite a previous restore. Compare against the private source inventory from step 2. Keep this verified copy offline; make a separate writable rehearsal copy owned by `openclaw`. Supply `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` explicitly in `/home/openclaw/.config/pantheon/rehearsal.env` (mode `0600`). Point the config at a reviewed copy of `deploy/openclaw.rehearsal.json` **outside** the state directory; supply a fresh `OPENCLAW_GATEWAY_TOKEN` there. Do not point at the production config or let a restored `.env` supply credentials. Check `openclaw config validate` with these settings before startup.

The rehearsal unit skips channel and scheduler startup regardless of restored job flags. Keep its skip flags and the explicit disabled config. Keep plugin, MCP, hook and integration config out of the first start, and inspect any runtime-discovered extensions and nonstandard workspace paths offline. If exact restored paths matter, recreate them only inside this isolated host. Leave active jobs and agent flags intact in the offline copy; never test job recovery by replaying production jobs. You can separately exercise representative job logic with synthetic inputs and a local, test-only destination.

| Credential or dependency | Rehearsal source |
| --- | --- |
| Gateway token | Fresh secret in the protected environment file. |
| OpenClaw's proxy client key | Same fresh test key on both sides, in protected files; replace the proxy template marker before starting. |
| Proxy provider authentication | Dedicated upstream test identities and privately reviewed mapping. For OAuth, use the proxy service account and its protected OAuth directory. Never copy the production OAuth directory. |
| Telegram token, calendar/MCP credentials, speech credentials, integration secrets | Omit from first rehearsal. For specific integration tests, issue separate test credentials and allowlist only those test destinations. |
| Restic secret and backend access | Separate recovery store available even if the original host or operator workstation is lost. |

Stage the rendered proxy config at `/etc/pantheon/cliproxyapi.yaml`, readable only by root and the proxy service account. The observed OpenClaw provider contracts are **Anthropic Messages** at `http://127.0.0.1:8317` and **OpenAI Responses** at `http://127.0.0.1:8317/v1`. A successful proxy health check does not prove their routing. Privately verify the model IDs and proxy routing/alias rules against the source and exercise one synthetic prompt per protocol from OpenClaw with a clean test workspace and session. Do not send restored memory or session contents to any provider. Use a separate synthetic state directory for these prompts. The public template does not include the production aliases or custom provider configuration.

Only after the isolation checks, reload and start both units explicitly on the rehearsal host. Check the UID, the loopback listeners (`18789`, `8317`), agent/workspace readability, sessions and saved job definitions. Confirm no Telegram polling, active jobs or unexpected outbound traffic. Prove both runtimes recover after a rehearsal-host reboot: if you explicitly enable units on that isolated host for the test, verify the skip flags and network boundary again after reboot, then disable the units at teardown. Rerun passive staging, confirm it refuses existing destinations, and verify the offline copy still matches its manifest. The rehearsal is incomplete until both providers and the required custom dependencies are validated; candidates to review include the speech extensions, calendar MCP server and local agent helpers. Keep private material out of Git and only commit source components after reviewing them for secrets and private content.

## 4. Repository transition and later cutover

The final pre-retirement bot revision is the parent of `03ff6ff` (the commit retiring the bot). Preserve it with the annotated `pantheon-legacy` tag; do not restore its workflow or start the old bot. Before merging the replacement, disable the remote `deploy.yml` workflow and verify it has no nonterminal runs. Do not retire any shared deploy credential without proving ownership and checking other consumers. Public CI must remain test-only.

Report pass/fail, aggregate counts and any no-go items; keep paths, content and credentials private. A later production move requires explicit approval, a fresh consistent final backup, and reconciliation of changes since rehearsal. Fence the old Telegram consumer and job scheduler before activating the new ones. If cutover fails, fence the new host before restarting the original and reconcile sessions and job side effects first. A Git rollback is not a runtime rollback.
