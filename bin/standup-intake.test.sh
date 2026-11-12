#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

# --- live copy of the intake and its lib, with a stub openclaw on PATH ---
L="$T/live"
mkdir -p "$L/remind-impl" "$T/bin" "$T/ws"
cp "$HERE/standup-intake" "$L/"
cp "$HERE/pantheon-state" "$L/"
cp -r "$HERE/pantheon_ops" "$L/"
cp "$HERE/remind-impl/remind-lib" "$L/remind-impl/"
sed -i "s|^export PATH=.*|export PATH=$T/bin:/usr/bin:/bin|" "$L/remind-impl/remind-lib"
export PANTHEON_WORKSPACE="$T/ws" PANTHEON_STATE_DIR="$T/state" PANTHEON_OPENCLAW_USER=pantheon_test_no_user
printf '777\n' > "$L/remind-impl/owner-chat"
cat > "$T/bin/openclaw" <<STUB
#!/bin/bash
printf '%s\n' "\$@" >> "$T/openclaw.args"
prev=
for a in "\$@"; do
  [ "\$prev" = "--message-file" ] && cp "\$a" "$T/message.seen"
  prev="\$a"
done
if [ -f "$T/native.json" ]; then cat "$T/native.json"; else echo '{"status":"ok"}'; fi
[ ! -f "$T/native.sleep" ] || sleep 0.3
exit \$(cat "$T/openclaw.rc" 2>/dev/null || echo 0)
STUB
chmod 755 "$T/bin/openclaw"

intake() { "$L/standup-intake" "$@"; }
D=2026-10-08
SUMMARY=$'**За последние 24 часа**\n- **rz-web-client** — PNRMN-401: маркеры статистики (влито, !337)\n'

# --- happy path: stored verbatim, one openclaw agent turn with exact argv ---
: > "$T/openclaw.args"
out=$(printf '%s' "$SUMMARY" | intake "$D") || fail "happy path rc=$?"
[[ "$out" == *'"status": "succeeded"'* && "$out" == *'"status": "unknown"'* ]] || fail "truthful stdout: $out"
cmp -s <(printf '%s' "$SUMMARY") "$T/ws/standups/$D.md" || fail "stored summary differs from stdin"
expected=$(printf '%s\n' agent --agent seneca --message-file '<MSG>' --deliver \
  --reply-channel telegram --reply-to 777 --timeout 300 --json)
[ "$(sed '5s|^/.*|<MSG>|' "$T/openclaw.args")" = "$expected" ] \
  || fail "argv: $(tr '\n' ' ' < "$T/openclaw.args")"
[ "$(head -n 1 "$T/message.seen")" = "[standup $D]" ] || fail "message line 1: $(head -n 1 "$T/message.seen")"
sed -n 2p "$T/message.seen" | grep -q "standups/$D.md" || fail "message line 2 does not name the file"
grep -q 'Format only the provided summary per AGENTS.md and reply only' "$T/message.seen" || fail 'formatting-only contract missing'
grep -q 'Sending is requested; its outcome is observed separately' "$T/message.seen" || fail 'sending observation contract missing'
! grep -q 'morning letter\|reply is delivered' "$T/message.seen" || fail 'obsolete letter/delivery instruction'
[ "$(sed -n 3p "$T/message.seen")" = "<<<SUMMARY" ] || fail "message opening marker"
[ "$(tail -n 1 "$T/message.seen")" = "SUMMARY>>>" ] || fail "message closing marker"
cmp -s <(sed '1,3d;$d' "$T/message.seen") <(printf '%s' "$SUMMARY") || fail "message summary is not verbatim"

# --- validation: rejected with 2 before anything is stored or openclaw runs ---
rejects() { # $1 label, then the intake's arguments; stdin goes to the intake
  local label="$1" before rc
  shift
  rm -f "$T/openclaw.args"
  before=$(ls -A "$T/ws/standups")
  set +e; intake "$@" >/dev/null 2>&1; rc=$?; set -e
  [ "$rc" -eq 2 ] || fail "$label: rc=$rc, want 2"
  [ ! -e "$T/openclaw.args" ] || fail "$label: openclaw ran"
  [ "$(ls -A "$T/ws/standups")" = "$before" ] || fail "$label: something was stored"
}
printf 'x\n' | rejects "no arguments"
printf 'x\n' | rejects "two arguments" "$D" extra
printf 'x\n' | rejects "short date" 2026-1-08
printf 'x\n' | rejects "not a calendar day" 2026-02-30
printf 'x\n' | rejects "month 13" 2026-13-01
printf 'x\n' | rejects "flag as the date" --deliver
printf '' | rejects "empty stdin" 2026-10-09
printf ' \n\t\n' | rejects "whitespace-only stdin" 2026-10-09
head -c 65537 /dev/zero | tr '\0' 'a' | rejects "65537 bytes" 2026-10-09
out=$(head -c 65536 /dev/zero | tr '\0' 'a' | intake 2026-10-10) || fail "65536 bytes rc=$?"
[ "$(wc -c < "$T/ws/standups/2026-10-10.md")" -eq 65536 ] || fail "65536 bytes were not stored whole"

# --- failures ---
expect_rc() { # $1 wanted rc, $2 label, then the command; stdin goes to the command
  local want="$1" label="$2" rc
  shift 2
  set +e; "$@" > "$T/out" 2>/dev/null; rc=$?; set -e
  [ "$rc" -eq "$want" ] || fail "$label: rc=$rc, want $want"
}

mv "$T/ws" "$T/ws.away"
printf 'x\n' | expect_rc 4 "missing workspace" intake 2026-10-11
[ ! -e "$T/ws" ] || fail "missing workspace: the intake created it"
mv "$T/ws.away" "$T/ws"

mv "$L/remind-impl/owner-chat" "$T/owner-chat.away"
rm -f "$T/openclaw.args"
printf 'x\n' | expect_rc 5 "missing owner chat" intake 2026-10-11
[ ! -e "$T/ws/standups/2026-10-11.md" ] || fail "missing owner chat: the summary was stored"
[ ! -e "$T/openclaw.args" ] || fail "missing owner chat: openclaw ran"
mv "$T/owner-chat.away" "$L/remind-impl/owner-chat"

echo 1 > "$T/openclaw.rc"
printf 'kept\n' | expect_rc 6 "openclaw failure" intake 2026-10-11
grep -q '"error_category": "native_exit"' "$T/out" || fail 'failure receipt missing'
[ "$(cat "$T/ws/standups/2026-10-11.md")" = "kept" ] || fail "openclaw failure: the summary was not kept"
rm -f "$T/openclaw.rc"

printf 'second\n' | expect_rc 2 'changed content refused' intake "$D"
cmp -s <(printf '%s' "$SUMMARY") "$T/ws/standups/$D.md" || fail 'changed content overwrote summary'
printf 'second\n' | intake "$D" --replace --resend > /dev/null || fail "explicit replacement rc=$?"
[ "$(cat "$T/ws/standups/$D.md")" = second ] || fail 'explicit replacement missing'
[ "$(ls -A "$T/ws/standups" | grep -c '^\.')" -eq 0 ] || fail "temp files left: $(ls -A "$T/ws/standups")"

printf 'line one\nlast line' | intake 2026-10-12 > /dev/null || fail "no trailing newline rc=$?"
cmp -s <(printf 'line one\nlast line') "$T/ws/standups/2026-10-12.md" || fail "no trailing newline: stored file changed"
[ "$(tail -n 2 "$T/message.seen" | head -n 1)" = "last line" ] || fail "no trailing newline: last summary line"
[ "$(tail -n 1 "$T/message.seen")" = "SUMMARY>>>" ] || fail "no trailing newline: closing marker not on its own line"

: > "$T/openclaw.args"
printf -- '--deliver is just my text\n' | intake 2026-10-13 > /dev/null || fail "flag-like summary rc=$?"
[ "$(cat "$T/ws/standups/2026-10-13.md")" = "--deliver is just my text" ] || fail "flag-like summary was altered"
[ "$(sed '5s|^/.*|<MSG>|' "$T/openclaw.args")" = "$expected" ] || fail "flag-like summary changed the argv"

# Replay exactly the recorded receipt; even a prior native failure never re-executes.
before=$(wc -l < "$T/openclaw.args")
printf -- '--deliver is just my text\n' | intake 2026-10-13 > "$T/first"
printf -- '--deliver is just my text\n' | intake 2026-10-13 > "$T/second"
cmp "$T/first" "$T/second" || fail 'duplicate receipt not replayed'
[ "$(wc -l < "$T/openclaw.args")" -eq "$before" ] || fail 'duplicate agent execution'

# Concurrent callers serialize through the native invocation; second replays.
echo yes > "$T/native.sleep"
: > "$T/openclaw.args"
printf 'parallel\n' | intake 2026-10-14 > "$T/parallel1" & p1=$!
printf 'parallel\n' | intake 2026-10-14 > "$T/parallel2" & p2=$!
wait "$p1"; wait "$p2"
cmp "$T/parallel1" "$T/parallel2" || fail 'concurrent receipt mismatch'
[ "$(grep -cx agent "$T/openclaw.args")" -eq 1 ] || fail 'concurrent double dispatch'
rm "$T/native.sleep"

# Real interruption after the durable dispatch boundary: do not start another turn.
echo yes > "$T/native.sleep"
printf 'crash\n' > "$T/crash-summary"
"$L/standup-intake" 2026-10-18 < "$T/crash-summary" > "$T/crash-out" 2>/dev/null & crash_pid=$!
for ((i=0; i<200; i++)); do
  if grep -q '"dispatch_started": true' "$T/state/standups/2026-10-18/state.json" 2>/dev/null; then break; fi
  sleep 0.01
done
grep -q '"dispatch_started": true' "$T/state/standups/2026-10-18/state.json" || fail 'did not reach durable dispatch'
kill -KILL "$crash_pid"
wait "$crash_pid" 2>/dev/null && fail 'killed intake succeeded'
sleep 0.4
before=$(wc -l < "$T/openclaw.args")
"$L/standup-intake" 2026-10-18 --resume > "$T/crash-resume"
[ "$(wc -l < "$T/openclaw.args")" -eq "$before" ] || fail 'crashed attempt redispatched'
grep -q '"status": "unknown"' "$T/crash-resume" || fail 'crash must remain unknown'
rm "$T/native.sleep"

# Acceptance remains pending even when native execution subsequently fails.
echo '{"status":"accepted","runId":"native-run-42"}' > "$T/native.json"
echo 1 > "$T/openclaw.rc"
printf 'pending\n' | expect_rc 6 'accepted native failure' intake 2026-10-15
grep -q native-run-42 "$T/out" || fail 'lost accepted run identity'
before=$(wc -l < "$T/openclaw.args")
expect_rc 6 'uncertain resume replays failure' intake 2026-10-15 --resume
[ "$(wc -l < "$T/openclaw.args")" -eq "$before" ] || fail 'resume redispatched uncertain attempt'
rm "$T/openclaw.rc" "$T/native.json"

# Interrupted persisted dispatch cannot automatically execute again.
python3 - "$T/state/standups/2026-10-15/state.json" <<'PY'
import json, sys
p = sys.argv[1]
v = json.load(open(p)); v['processing']['status'] = 'unknown'; v['dispatch_started'] = True
with open(p, 'w') as f: json.dump(v, f)
PY
expect_rc 6 'interrupted attempt replays failure' intake 2026-10-15 --resume
[ "$(wc -l < "$T/openclaw.args")" -eq "$before" ] || fail 'interrupted attempt re-executed'

# Legacy file-only input is stored-only and never automatically dispatched.
printf legacy > "$T/ws/standups/2026-10-16.md"
printf legacy | intake 2026-10-16 > "$T/legacy"
grep -q '"legacy": true' "$T/legacy" || fail 'legacy not identified'
[ "$(wc -l < "$T/openclaw.args")" -eq "$before" ] || fail 'legacy dispatched'
printf changed | expect_rc 2 'legacy change needs both flags' intake 2026-10-16 --resend

# Permissions/timestamps/redaction and read-only lookup.
[ "$(stat -c %a "$T/state")" = 700 ] || fail 'state directory mode'
[ "$(stat -c %a "$T/state/standups/$D/state.json")" = 600 ] || fail 'state file mode'
[ "$(stat -c %a "$T/ws/standups/$D.md")" = 600 ] || fail 'summary file mode'
"$L/pantheon-state" status "$D" > "$T/status"
python3 - "$T/status" <<'PY'
import json, sys
def check(value):
    if isinstance(value, dict):
        assert not {'summary', 'stderr', 'chat', 'target'} & value.keys()
        for child in value.values(): check(child)
    elif isinstance(value, list):
        for child in value: check(child)
    else:
        assert value not in ('777', 'second', 'SUMMARY'), 'status leaked content or chat'
check(json.load(open(sys.argv[1])))
PY
grep -q '"stored_at": "[0-9].*+\|"stored_at": "[0-9].*Z"' "$T/status" || fail 'missing UTC storage time'

# Root/runuser seam: fake executor runs no real identity transition or native call.
if [ "$(id -u)" -eq 0 ]; then
  cat > "$T/bin/runuser-stub" <<STUB
#!/bin/bash
printf '%s\n' "\$@" > "$T/runuser.args"
shift 3
exec "\$@"
STUB
  chmod 755 "$T/bin/runuser-stub"
  export PANTHEON_OPENCLAW_USER=root PANTHEON_OPENCLAW_HOME="$T/owner-home" PANTHEON_RUNUSER="$T/bin/runuser-stub"
  printf root-seam | intake 2026-10-17 > /dev/null
  grep -qx "HOME=$T/owner-home" "$T/runuser.args" || fail 'runuser HOME missing'
  PANTHEON_RUNUSER="$T/not-executable" expect_rc 4 'root must not bypass runuser' intake 2026-10-20 < "$T/crash-summary"
fi

echo "OK"
