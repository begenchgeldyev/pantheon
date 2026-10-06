#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMPL="$HERE/remind-impl"
. "$IMPL/remind-lib"
fail() { echo "FAIL: $*" >&2; exit 1; }

# --- PATH: which openclaw we run is fixed by the lib, never by the caller ---
case "$PATH" in
  *":/home/openclaw/.openclaw/tools/node/bin" ) : ;;
  * ) fail "PATH after sourcing remind-lib: $PATH" ;;
esac
case "$PATH" in
  *"node-""v24"* ) fail "remind-lib PATH still points at the removed node dir" ;;
esac

T=$(mktemp -d)

# --- live copy of the impl with a stub openclaw on PATH ---
V="$T/live"
cp -a "$IMPL"/. "$V/"
sed -i "s|^export PATH=.*|export PATH=$T/bin:/usr/bin:/bin|" "$V/remind-lib" "$V/remind-in"
mkdir -p "$T/bin"
cat > "$T/bin/openclaw" <<STUB
#!/bin/bash
printf '%s\n' "\$@" >> "$T/openclaw.args"
case "\$1 \$2" in
  "cron list") cat "$T/cron-list.json" ;;
  *) echo '{"id":"job-1"}' ;;
esac
STUB
chmod 755 "$T/bin/openclaw"
cat > "$T/cron-list.json" <<'JSON'
{"jobs":[{"id":"abc","name":"u_42--n","schedule":{"kind":"at","at":"2030-01-01T00:00:00Z"},"state":{}}]}
JSON

# --- helpers ---
pantheon_check_agent main || fail "main is a valid agent id"
pantheon_check_agent u_42 || fail "u_42 is a valid agent id"
( pantheon_check_agent "u_42; id" 2>/dev/null ) && fail "injection id must be rejected" || true

# --- chat resolution: u_<id> is self-evident; owner agents read owner-chat ---
. "$V/remind-lib"
out=$(pantheon_chat_for_agent u_42) || fail "chat u_42 rc"
[ "$out" = "42" ] || fail "chat u_42 gave: $out"
printf '777\n' > "$V/owner-chat"
out=$(pantheon_chat_for_agent zeus) || fail "chat zeus rc"
[ "$out" = "777" ] || fail "chat zeus gave: $out"
out=$(pantheon_chat_for_agent main) || fail "chat main rc"
[ "$out" = "777" ] || fail "chat main gave: $out"
mv "$V/owner-chat" "$T/owner-chat.bak"
( pantheon_chat_for_agent zeus 2>/dev/null ) && fail "chat without owner-chat must fail" || [ $? -eq 5 ]
printf 'abc\n' > "$T/owner-chat.bak"
mv "$T/owner-chat.bak" "$V/owner-chat"
( pantheon_chat_for_agent main 2>/dev/null ) && fail "chat with non-numeric owner-chat must fail" || [ $? -eq 5 ]
printf '777\n' > "$V/owner-chat"

# --- argv: exactly what openclaw cron receives (via the stub) ---
: > "$T/openclaw.args"
"$V/remind" u_42 2030-01-01T00:00:00Z n "hi there" >/dev/null 2>&1 || fail "remind run failed"
expected=$(printf '%s\n' 'cron' 'add' '--name=u_42--n' '--agent=u_42' '--at=2030-01-01T00:00:00Z' '--command-argv=["/bin/cat"]' '--command-input=hi there' '--announce' '--channel=telegram' '--to=42' '--delete-after-run')
[ "$(cat "$T/openclaw.args")" = "$expected" ] || fail "remind argv: $(tr '\n' ' ' < "$T/openclaw.args")"

: > "$T/openclaw.args"
"$V/remind-cron" main "0 9 * * *" rent "📜 rent" >/dev/null 2>&1 || fail "remind-cron run failed"
expected=$(printf '%s\n' 'cron' 'add' '--name=main--rent' '--agent=main' '--cron=0 9 * * *' '--command-argv=["/bin/cat"]' '--command-input=📜 rent' '--announce' '--channel=telegram' '--to=777')
[ "$(cat "$T/openclaw.args")" = "$expected" ] || fail "remind-cron argv: $(tr '\n' ' ' < "$T/openclaw.args")"

# A flag-looking message must reach openclaw only as --command-input text.
: > "$T/openclaw.args"
"$V/remind" u_42 2030-01-01T00:00:00Z n "--delete-after-run is just my text" >/dev/null 2>&1 || fail "remind (flag-ish msg) run failed"
expected=$(printf '%s\n' 'cron' 'add' '--name=u_42--n' '--agent=u_42' '--at=2030-01-01T00:00:00Z' '--command-argv=["/bin/cat"]' '--command-input=--delete-after-run is just my text' '--announce' '--channel=telegram' '--to=42' '--delete-after-run')
[ "$(cat "$T/openclaw.args")" = "$expected" ] || fail "flag-ish message argv: $(tr '\n' ' ' < "$T/openclaw.args")"
grep -Eq 'cur''l|no''tify|best-effort' "$T/openclaw.args" && fail "forbidden content in argv" || true

"$V/remind" u_42 2030-01-01T00:00:00Z n "" 2>/dev/null && fail "empty message must be rejected" || [ $? -eq 2 ]

mv "$V/owner-chat" "$T/owner-chat.bak"
rm -f "$T/openclaw.args"
"$V/remind" zeus 2030-01-01T00:00:00Z n msg 2>/dev/null && fail "missing owner-chat must fail" || [ $? -eq 5 ]
[ ! -e "$T/openclaw.args" ] || fail "openclaw ran without owner-chat"
mv "$T/owner-chat.bak" "$V/owner-chat"

out=$("$V/remind-list" u_42)
grep -q '^n' <<<"$out" || fail "remind-list out: $out"
grep -q '2030-01-01T00:00:00Z' <<<"$out" || fail "remind-list out: $out"
: > "$T/openclaw.args"
"$V/remind-rm" u_42 n >/dev/null
[ "$(cat "$T/openclaw.args")" = "$(printf '%s\n' cron list --json cron rm abc)" ] || fail "remind-rm argv: $(tr '\n' ' ' < "$T/openclaw.args")"

# --- agent id validation (the id comes from the wrapper, never from the caller) ---
"$IMPL/remind-list" Evil 2>/dev/null && fail "remind-list bad agent" || [ $? -eq 3 ]
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
"$HERE/install-remind-wrappers" "Evil" "$T/agents/Evil" 2>/dev/null && fail "installer bad agent" || [ $? -eq 3 ]
[ ! -d "$T/agents/Evil" ] || fail "installer created a dir for an invalid agent"

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
