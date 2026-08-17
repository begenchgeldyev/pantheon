#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/remind-lib"
fail() { echo "FAIL: $*" >&2; exit 1; }

T=$(mktemp -d)
mkdir -p "$T/workspace" "$T/workspace-u_42" "$T/other"
( cd "$T/workspace"      && [ "$(pantheon_agent_id)" = "main" ] ) || fail "main mapping"
( cd "$T/workspace-u_42" && [ "$(pantheon_agent_id)" = "u_42" ] ) || fail "u_42 mapping"
( cd "$T/other" && pantheon_agent_id 2>/dev/null ) && fail "other should fail" || true
[ "$(notify_body u_42 'hi "there"')" = '{"agentId":"u_42","text":"hi \"there\""}' ] || fail "body"
"$HERE/remind" 2>/dev/null && fail "remind usage" || [ $? -eq 2 ]
"$HERE/remind-in" 2>/dev/null && fail "remind-in usage" || [ $? -eq 2 ]
"$HERE/remind-cron" 2>/dev/null && fail "remind-cron usage" || [ $? -eq 2 ]
"$HERE/remind-rm" 2>/dev/null && fail "remind-rm usage" || [ $? -eq 2 ]
rm -rf "$T"
echo "OK"
