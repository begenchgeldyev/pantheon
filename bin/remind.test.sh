#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMPL="$HERE/remind-impl"
. "$IMPL/remind-lib"
fail() { echo "FAIL: $*" >&2; exit 1; }

T=$(mktemp -d)

# --- helpers ---
[ "$(notify_body u_42 'hi "there"')" = '{"agentId":"u_42","text":"hi \"there\""}' ] || fail "body"
pantheon_check_agent main || fail "main is a valid agent id"
pantheon_check_agent u_42 || fail "u_42 is a valid agent id"
( pantheon_check_agent "u_42; id" 2>/dev/null ) && fail "injection id must be rejected" || true

# --- agent id validation (the id comes from the wrapper, never from the caller) ---
"$IMPL/remind-list" evil 2>/dev/null && fail "remind-list bad agent" || [ $? -eq 3 ]
"$IMPL/remind-list" "u_42; id" 2>/dev/null && fail "remind-list injection" || [ $? -eq 3 ]
"$IMPL/remind" main-evil 2030-01-01T00:00:00Z n msg 2>/dev/null && fail "remind bad agent" || [ $? -eq 3 ]
"$IMPL/remind-cron" "" "0 9 * * *" n msg 2>/dev/null && fail "remind-cron empty agent" || [ $? -eq 3 ]
"$IMPL/remind-rm" ../main n 2>/dev/null && fail "remind-rm path-ish agent" || [ $? -eq 3 ]

# --- usage ---
"$IMPL/remind" 2>/dev/null && fail "remind usage" || [ $? -eq 2 ]
"$IMPL/remind-in" u_42 2>/dev/null && fail "remind-in usage" || [ $? -eq 2 ]
"$IMPL/remind-cron" u_42 "0 9 * * *" 2>/dev/null && fail "remind-cron usage" || [ $? -eq 2 ]
"$IMPL/remind-rm" u_42 2>/dev/null && fail "remind-rm usage" || [ $? -eq 2 ]
"$IMPL/remind-list" 2>/dev/null && fail "remind-list usage" || [ $? -eq 2 ]

# --- argument validation (must reject before `openclaw` is ever invoked) ---
"$IMPL/remind" u_42 2030-01-01T00:00:00Z "bad name" msg 2>/dev/null && fail "remind bad name" || [ $? -eq 2 ]
"$IMPL/remind" u_42 2030-01-01T00:00:00Z -- msg 2>/dev/null && fail "remind flag-ish name" || [ $? -eq 2 ]
"$IMPL/remind" u_42 --at foo msg 2>/dev/null && fail "remind bad timestamp" || [ $? -eq 2 ]
"$IMPL/remind-cron" u_42 "--command x" n msg 2>/dev/null && fail "remind-cron bad expr" || [ $? -eq 2 ]
"$IMPL/remind-cron" u_42 "0 9 * * *" "Bad_Name" msg 2>/dev/null && fail "remind-cron bad name" || [ $? -eq 2 ]
"$IMPL/remind-rm" u_42 "Bad_Name" 2>/dev/null && fail "remind-rm bad name" || [ $? -eq 2 ]

# --- wrapper installation ---
mkdir -p "$T/impl"
REMIND_IMPL_DIR="$T/impl" "$HERE/install-remind-wrappers" u_42 "$T/agents/u_42" >/dev/null
for name in remind remind-in remind-cron remind-list remind-rm; do
  w="$T/agents/u_42/$name"
  [ -x "$w" ] || fail "wrapper $name is not executable"
  [ "$(stat -c %a "$w")" = "755" ] || fail "wrapper $name mode is $(stat -c %a "$w")"
  expected=$(printf '#!/bin/sh\nexec %s/%s u_42 "$@"\n' "$T/impl" "$name")
  [ "$(cat "$w")" = "$expected" ] || fail "wrapper $name content: $(cat "$w")"
done
"$HERE/install-remind-wrappers" 2>/dev/null && fail "installer usage" || [ $? -eq 2 ]
"$HERE/install-remind-wrappers" "evil" "$T/agents/evil" 2>/dev/null && fail "installer bad agent" || [ $? -eq 3 ]
[ ! -d "$T/agents/evil" ] || fail "installer created a dir for an invalid agent"

# A wrapper really does pin the agent id: the impl sees u_42 even when the
# caller passes another id as its first argument.
cat > "$T/impl/remind-list" <<'STUB'
#!/bin/bash
echo "agent=$1 rest=${*:2}"
STUB
chmod 755 "$T/impl/remind-list"
out=$("$T/agents/u_42/remind-list" main)
[ "$out" = "agent=u_42 rest=main" ] || fail "wrapper did not pin the agent id: $out"

rm -rf "$T"
echo "OK"
