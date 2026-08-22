#!/bin/sh
set -eu

IMPL_SRC="/app/bin/remind-impl"
IMPL_DST="/home/openclaw/bin/remind-impl"

if [ -d "$IMPL_SRC" ]; then
    mkdir -p "$IMPL_DST"
    cp -a "$IMPL_SRC"/. "$IMPL_DST"/
fi

exec bun run src/index.ts
