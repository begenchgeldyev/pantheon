#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
JOB="$HERE/seneca-standup"
fail() { echo "FAIL: $*" >&2; exit 1; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"

# --- stubs log what they were given; their exit codes come from files ---
cat > "$T/bin/collect" <<STUB
#!/bin/bash
printf '%s\n' "\$@" > "$T/collect.args"
[ -f "$T/collect.stderr" ] && cat "$T/collect.stderr" >&2
echo "COLLECTED-DATA"
exit \$(cat "$T/collect.rc" 2>/dev/null || echo 0)
STUB
cat > "$T/bin/opencode" <<STUB
#!/bin/bash
printf '%s\n' "\$@" > "$T/opencode.args"
cat > "$T/opencode.stdin"
cat "$T/summary.txt"
exit \$(cat "$T/opencode.rc" 2>/dev/null || echo 0)
STUB
cat > "$T/bin/ssh" <<STUB
#!/bin/bash
echo "\$*" >> "$T/ssh.calls"
cat > "$T/ssh.stdin"
rc=\$(head -n 1 "$T/ssh.rcs" 2>/dev/null || true)
sed -i 1d "$T/ssh.rcs" 2>/dev/null || true
[ "\${rc:-0}" -eq 0 ] && echo "delivered stub"
exit "\${rc:-0}"
STUB
cat > "$T/bin/notify" <<STUB
#!/bin/bash
printf '%s\n' "\$@" > "$T/notify.args"
STUB
chmod 755 "$T"/bin/*
printf 'SKILL-RULES-MARKER\n' > "$T/SKILL.md"

export SENECA_COLLECT="$T/bin/collect" SENECA_SKILL="$T/SKILL.md" SENECA_OPENCODE="$T/bin/opencode" \
  SENECA_MODEL=proxy/gpt-6.1-sol SENECA_OPENCODE_TIMEOUT=30 \
  SENECA_SSH="$T/bin/ssh" SENECA_NOTIFY="$T/bin/notify" SENECA_HOST=server-test \
  SENECA_INTAKE=/srv/intake SENECA_SSH_RETRIES=3 SENECA_SSH_BACKOFF=0
export SENECA_STATE_DIR="$T/state" SENECA_STATE_HELPER="$HERE/../bin/pantheon-state"

reset() {
  rm -rf "$T/state"
  rm -f "$T"/*.args "$T"/*.rc "$T/collect.stderr" "$T/ssh.calls" "$T/ssh.rcs" "$T/ssh.stdin" "$T/opencode.stdin"
  printf '**За последние 24 часа**\n- **rz-web-client** — работа\n' > "$T/summary.txt"
}
run() { # $1 the date the job runs for
  set +e; SENECA_DATE="$1" "$JOB" > "$T/out" 2> "$T/err"; RC=$?; set -e
}

# --- a Thursday: one day of commits, summarised and handed to the intake ---
reset
run 2026-10-08
[ "$RC" -eq 0 ] || fail "thursday rc=$RC: $(cat "$T/err")"
[ "$(cat "$T/collect.args")" = "1d" ] || fail "thursday window: $(cat "$T/collect.args")"
[ "$(cat "$T/opencode.args")" = "$(printf '%s\n' run --model proxy/gpt-6.1-sol --standalone)" ] \
  || fail "opencode argv: $(tr '\n' '|' < "$T/opencode.args")"
grep -q 'SKILL-RULES-MARKER' "$T/opencode.stdin" || fail "the prompt lacks the skill"
grep -q 'COLLECTED-DATA' "$T/opencode.stdin" || fail "the prompt lacks the collected data"
grep -q '«За последние 24 часа»' "$T/opencode.stdin" || fail "the prompt lacks the 1d heading"
[ "$(cat "$T/ssh.calls")" = "-o BatchMode=yes -o ConnectTimeout=20 server-test /srv/intake 2026-10-08" ] \
  || fail "ssh argv: $(cat "$T/ssh.calls")"
cmp -s "$T/summary.txt" "$T/ssh.stdin" || fail "ssh stdin is not the summary"
[ ! -e "$T/notify.args" ] || fail "a good run notified: $(cat "$T/notify.args")"
! grep -q 'seneca-standup: delivered' "$T/out" || fail "exit zero must not claim delivery: $(cat "$T/out")"

# --- a Monday reaches back over the weekend to Friday ---
reset
run 2026-10-12
[ "$RC" -eq 0 ] || fail "monday rc=$RC: $(cat "$T/err")"
[ "$(cat "$T/collect.args")" = "3d" ] || fail "monday window: $(cat "$T/collect.args")"
grep -q '«За 3 дня»' "$T/opencode.stdin" || fail "the prompt lacks the 3d heading"
grep -q 'server-test /srv/intake 2026-10-12$' "$T/ssh.calls" || fail "monday ssh argv: $(cat "$T/ssh.calls")"

# --- a failed step stops the run with one notification that names it ---
fails_at() { # $1 the step the notification must name
  [ "$RC" -eq 1 ] || fail "$1: rc=$RC, want 1"
  [ -e "$T/notify.args" ] || fail "$1: no notification"
  [ "$(head -n 4 "$T/notify.args" | tr '\n' '|')" = "-a|Seneca|-u|critical|" ] \
    || fail "$1: notify flags: $(tr '\n' '|' < "$T/notify.args")"
  [ "$(sed -n 5p "$T/notify.args")" = "Сенека: стендап не отправлен — $1" ] \
    || fail "$1: notification title: $(sed -n 5p "$T/notify.args")"
}

reset; run 2026-02-30
fails_at date
[ ! -e "$T/collect.args" ] || fail "date: collect ran"

reset; echo 1 > "$T/collect.rc"; run 2026-10-08
fails_at collect
[ ! -e "$T/opencode.args" ] || fail "collect: opencode ran"
[ ! -e "$T/ssh.calls" ] || fail "collect: ssh ran"

# the full failing stderr reaches the journal — the root cause is not lost
reset
printf 'root cause: no such ref\nctx a\nctx b\nctx c\nctx d\n' > "$T/collect.stderr"
echo 1 > "$T/collect.rc"
run 2026-10-08
fails_at collect
grep -q 'root cause: no such ref' "$T/err" || fail "collect stderr root cause lost: $(cat "$T/err")"

reset; export SENECA_SKILL="$T/missing.md"; run 2026-10-08; export SENECA_SKILL="$T/SKILL.md"
fails_at skill
[ ! -e "$T/opencode.args" ] || fail "skill: opencode ran"

# a readable path that `cat` cannot actually read (a directory) must stop delivery
reset; export SENECA_SKILL="$T"; run 2026-10-08; export SENECA_SKILL="$T/SKILL.md"
fails_at skill
[ ! -e "$T/opencode.args" ] || fail "skill-dir: opencode ran"
[ ! -e "$T/ssh.calls" ] || fail "skill-dir: ssh ran"

# a mid-block prompt failure (reading skill.body) must also stop delivery
reset
cat > "$T/bin/cat" <<'SHIM'
#!/bin/bash
for a in "$@"; do case "$a" in *skill.body) echo "cat: injected failure" >&2; exit 1;; esac; done
exec /bin/cat "$@"
SHIM
chmod 755 "$T/bin/cat"
PATH="$T/bin:$PATH" run 2026-10-08
fails_at prompt
[ ! -e "$T/opencode.args" ] || fail "prompt: opencode ran"
[ ! -e "$T/ssh.calls" ] || fail "prompt: ssh ran"

reset; echo 1 > "$T/opencode.rc"; run 2026-10-08
fails_at opencode
[ ! -e "$T/ssh.calls" ] || fail "opencode: ssh ran"

# opencode reports API errors on stdout: the journal must carry that text, not just rc
reset; echo 1 > "$T/opencode.rc"
printf 'API Error: 400 unknown provider for model x\n' > "$T/summary.txt"
run 2026-10-08
fails_at opencode
grep -q 'unknown provider for model x' "$T/err" || fail "opencode stdout lost: $(cat "$T/err")"
[ ! -e "$T/ssh.calls" ] || fail "opencode stdout: ssh ran"

reset; printf ' \n\n' > "$T/summary.txt"; run 2026-10-08
fails_at summary
[ ! -e "$T/ssh.calls" ] || fail "summary: ssh ran"

reset; printf '255\n255\n255\n' > "$T/ssh.rcs"; run 2026-10-08
fails_at ssh
[ "$(wc -l < "$T/ssh.calls")" -eq 1 ] || fail "ssh: ambiguous dispatch must not be retried"

reset; printf '255\n0\n' > "$T/ssh.rcs"; run 2026-10-08
[ "$RC" -eq 1 ] || fail "ambiguous ssh: rc=$RC"
[ "$(wc -l < "$T/ssh.calls")" -eq 1 ] || fail "ambiguous ssh was retried"

# Resume uses the durable summary, not another collection/model turn.
rm -f "$T/collect.args" "$T/opencode.args"
SENECA_DATE=2026-10-08 "$JOB" --resume > "$T/out" 2> "$T/err" || fail 'resume failed'
[ ! -e "$T/collect.args" ] && [ ! -e "$T/opencode.args" ] || fail 'resume regenerated'
[ "$(wc -l < "$T/ssh.calls")" -eq 2 ] || fail 'resume did not submit once'
SENECA_DATE=2026-10-08 "$JOB" --status > "$T/status" || fail 'status failed'
[ "$(wc -l < "$T/ssh.calls")" -eq 2 ] || fail 'status submitted'
! grep -q 'COLLECTED-DATA\|работа' "$T/status" || fail 'status leaked content'

for rc in 2 6; do
  reset; echo "$rc" > "$T/ssh.rcs"; run 2026-10-08
  fails_at intake
  [ "$(wc -l < "$T/ssh.calls")" -eq 1 ] || fail "intake rc $rc was retried"
done

# End-to-end mocked SSH loss AFTER remote acceptance, then explicit safe resume.
reset
mkdir -p "$T/server/remind-impl" "$T/ws"
cp "$HERE/../bin/standup-intake" "$HERE/../bin/pantheon-state" "$T/server/"
cp -r "$HERE/../bin/pantheon_ops" "$T/server/"
cp "$HERE/../bin/remind-impl/remind-lib" "$T/server/remind-impl/"
sed -i "s|^export PATH=.*|export PATH=$T/bin:/usr/bin:/bin|" "$T/server/remind-impl/remind-lib"
printf '777\n' > "$T/server/remind-impl/owner-chat"
cat > "$T/bin/openclaw" <<STUB
#!/bin/bash
echo native >> "$T/native.calls"
echo '{"status":"accepted","runId":"accepted-before-ssh-loss"}'
STUB
cat > "$T/bin/ssh" <<STUB
#!/bin/bash
shift 6
"$T/server/standup-intake" "\$@"
rc=\$?
if [ ! -f "$T/ssh-lost" ]; then touch "$T/ssh-lost"; exit 255; fi
exit "\$rc"
STUB
chmod 755 "$T/bin/openclaw" "$T/bin/ssh"
export PANTHEON_STATE_DIR="$T/server-state" PANTHEON_WORKSPACE="$T/ws" PANTHEON_OPENCLAW_USER=pantheon_test_no_user
run 2026-10-19
[ "$RC" -eq 1 ] || fail 'SSH loss was reported as success'
[ "$(wc -l < "$T/native.calls")" -eq 1 ] || fail 'initial dispatch count'
rm -f "$T/collect.args" "$T/opencode.args"
SENECA_DATE=2026-10-19 "$JOB" --resume > "$T/out" 2> "$T/err" || fail 'safe resume failed'
[ "$(wc -l < "$T/native.calls")" -eq 1 ] || fail 'SSH loss/resume invoked agent twice'
[ ! -f "$T/collect.args" ] && [ ! -f "$T/opencode.args" ] || fail 'safe resume recollected'
grep -q accepted-before-ssh-loss "$T/server-state/standups/2026-10-19/state.json" || fail 'lost native run'

# Default logical date explicitly asks for Tomsk, even on a different host TZ.
cat > "$T/bin/date" <<STUB
#!/bin/bash
if [ "\$*" = '+%F' ]; then
  printf '%s' "\$TZ" > "$T/date.tz"
  echo 2026-10-20
else exec /usr/bin/date "\$@"; fi
STUB
chmod 755 "$T/bin/date"
PATH="$T/bin:$PATH" TZ=UTC "$JOB" --status > "$T/date.status" || fail 'default date status'
[ "$(cat "$T/date.tz")" = Asia/Tomsk ] || fail 'default date did not use Tomsk'

echo "OK"
