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
cp "$HERE/remind-impl/remind-lib" "$L/remind-impl/"
sed -i "s|^export PATH=.*|export PATH=$T/bin:/usr/bin:/bin|" "$L/remind-impl/remind-lib"
sed -i "s|^WORKSPACE=.*|WORKSPACE=$T/ws|" "$L/standup-intake"
grep -qx "WORKSPACE=$T/ws" "$L/standup-intake" || fail "WORKSPACE constant was not rewritten"
printf '777\n' > "$L/remind-impl/owner-chat"
cat > "$T/bin/openclaw" <<STUB
#!/bin/bash
printf '%s\n' "\$@" >> "$T/openclaw.args"
prev=
for a in "\$@"; do
  [ "\$prev" = "--message-file" ] && cp "\$a" "$T/message.seen"
  prev="\$a"
done
echo '{"status":"ok"}'
exit \$(cat "$T/openclaw.rc" 2>/dev/null || echo 0)
STUB
chmod 755 "$T/bin/openclaw"

intake() { "$L/standup-intake" "$@"; }
D=2026-10-08
SUMMARY=$'**За последние 24 часа**\n- **rz-web-client** — PNRMN-401: маркеры статистики (влито, !337)\n'

# --- happy path: stored verbatim, one openclaw agent turn with exact argv ---
: > "$T/openclaw.args"
out=$(printf '%s' "$SUMMARY" | intake "$D") || fail "happy path rc=$?"
[ "$out" = "delivered $D" ] || fail "happy path stdout: $out"
cmp -s <(printf '%s' "$SUMMARY") "$T/ws/standups/$D.md" || fail "stored summary differs from stdin"
expected=$(printf '%s\n' agent --agent seneca --message-file '<MSG>' --deliver \
  --reply-channel telegram --reply-to 777 --timeout 300 --json)
[ "$(sed '5s|^/.*|<MSG>|' "$T/openclaw.args")" = "$expected" ] \
  || fail "argv: $(tr '\n' ' ' < "$T/openclaw.args")"
[ "$(head -n 1 "$T/message.seen")" = "[standup $D]" ] || fail "message line 1: $(head -n 1 "$T/message.seen")"
sed -n 2p "$T/message.seen" | grep -q "standups/$D.md" || fail "message line 2 does not name the file"
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
[ ! -s "$T/out" ] || fail "openclaw failure printed to stdout: $(cat "$T/out")"
[ "$(cat "$T/ws/standups/2026-10-11.md")" = "kept" ] || fail "openclaw failure: the summary was not kept"
rm -f "$T/openclaw.rc"

printf 'second\n' | intake "$D" > /dev/null || fail "rerun rc=$?"
[ "$(cat "$T/ws/standups/$D.md")" = "second" ] || fail "rerun did not replace the summary"
[ "$(ls -A "$T/ws/standups" | grep -c '^\.')" -eq 0 ] || fail "temp files left: $(ls -A "$T/ws/standups")"

printf 'line one\nlast line' | intake 2026-10-12 > /dev/null || fail "no trailing newline rc=$?"
cmp -s <(printf 'line one\nlast line') "$T/ws/standups/2026-10-12.md" || fail "no trailing newline: stored file changed"
[ "$(tail -n 2 "$T/message.seen" | head -n 1)" = "last line" ] || fail "no trailing newline: last summary line"
[ "$(tail -n 1 "$T/message.seen")" = "SUMMARY>>>" ] || fail "no trailing newline: closing marker not on its own line"

: > "$T/openclaw.args"
printf -- '--deliver is just my text\n' | intake 2026-10-13 > /dev/null || fail "flag-like summary rc=$?"
[ "$(cat "$T/ws/standups/2026-10-13.md")" = "--deliver is just my text" ] || fail "flag-like summary was altered"
[ "$(sed '5s|^/.*|<MSG>|' "$T/openclaw.args")" = "$expected" ] || fail "flag-like summary changed the argv"

echo "OK"
