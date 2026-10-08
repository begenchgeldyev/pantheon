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
cat > "$T/bin/claude" <<STUB
#!/bin/bash
printf '%s\n' "\$@" > "$T/claude.args"
cat > "$T/claude.stdin"
cat "$T/summary.txt"
exit \$(cat "$T/claude.rc" 2>/dev/null || echo 0)
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

export SENECA_COLLECT="$T/bin/collect" SENECA_SKILL="$T/SKILL.md" SENECA_CLAUDE="$T/bin/claude" \
  SENECA_SSH="$T/bin/ssh" SENECA_NOTIFY="$T/bin/notify" SENECA_HOST=kz-test \
  SENECA_INTAKE=/srv/intake SENECA_SSH_RETRIES=3 SENECA_SSH_BACKOFF=0

reset() {
  rm -f "$T"/*.args "$T"/*.rc "$T/collect.stderr" "$T/ssh.calls" "$T/ssh.rcs" "$T/ssh.stdin" "$T/claude.stdin"
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
[ "$(cat "$T/claude.args")" = "$(printf '%s\n' -p --tools '' --strict-mcp-config --no-session-persistence)" ] \
  || fail "claude argv: $(tr '\n' '|' < "$T/claude.args")"
grep -q 'SKILL-RULES-MARKER' "$T/claude.stdin" || fail "the prompt lacks the skill"
grep -q 'COLLECTED-DATA' "$T/claude.stdin" || fail "the prompt lacks the collected data"
grep -q '«За последние 24 часа»' "$T/claude.stdin" || fail "the prompt lacks the 1d heading"
[ "$(cat "$T/ssh.calls")" = "-o BatchMode=yes -o ConnectTimeout=20 kz-test /srv/intake 2026-10-08" ] \
  || fail "ssh argv: $(cat "$T/ssh.calls")"
cmp -s "$T/summary.txt" "$T/ssh.stdin" || fail "ssh stdin is not the summary"
[ ! -e "$T/notify.args" ] || fail "a good run notified: $(cat "$T/notify.args")"
grep -q 'delivered 2026-10-08' "$T/out" || fail "thursday stdout: $(cat "$T/out")"

# --- a Monday reaches back over the weekend to Friday ---
reset
run 2026-10-12
[ "$RC" -eq 0 ] || fail "monday rc=$RC: $(cat "$T/err")"
[ "$(cat "$T/collect.args")" = "3d" ] || fail "monday window: $(cat "$T/collect.args")"
grep -q '«За 3 дня»' "$T/claude.stdin" || fail "the prompt lacks the 3d heading"
grep -q 'kz-test /srv/intake 2026-10-12$' "$T/ssh.calls" || fail "monday ssh argv: $(cat "$T/ssh.calls")"

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
[ ! -e "$T/claude.args" ] || fail "collect: claude ran"
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
[ ! -e "$T/claude.args" ] || fail "skill: claude ran"

# a readable path that `cat` cannot actually read (a directory) must stop delivery
reset; export SENECA_SKILL="$T"; run 2026-10-08; export SENECA_SKILL="$T/SKILL.md"
fails_at skill
[ ! -e "$T/claude.args" ] || fail "skill-dir: claude ran"
[ ! -e "$T/ssh.calls" ] || fail "skill-dir: ssh ran"

reset; echo 1 > "$T/claude.rc"; run 2026-10-08
fails_at claude
[ ! -e "$T/ssh.calls" ] || fail "claude: ssh ran"

reset; printf ' \n\n' > "$T/summary.txt"; run 2026-10-08
fails_at summary
[ ! -e "$T/ssh.calls" ] || fail "summary: ssh ran"

reset; printf '255\n255\n255\n' > "$T/ssh.rcs"; run 2026-10-08
fails_at ssh
[ "$(wc -l < "$T/ssh.calls")" -eq 3 ] || fail "ssh: $(wc -l < "$T/ssh.calls") attempts, want 3"

reset; printf '255\n0\n' > "$T/ssh.rcs"; run 2026-10-08
[ "$RC" -eq 0 ] || fail "ssh retry: rc=$RC"
[ "$(wc -l < "$T/ssh.calls")" -eq 2 ] || fail "ssh retry: $(wc -l < "$T/ssh.calls") attempts, want 2"
[ ! -e "$T/notify.args" ] || fail "ssh retry notified"

for rc in 2 6; do
  reset; echo "$rc" > "$T/ssh.rcs"; run 2026-10-08
  fails_at intake
  [ "$(wc -l < "$T/ssh.calls")" -eq 1 ] || fail "intake rc $rc was retried"
done

echo "OK"
