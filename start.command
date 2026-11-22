#!/bin/bash
# One-click start for the local Superagent 2.0 host.
# Panel: http://127.0.0.1:3082/  — the page carries its own token, no sign-in.
# Options pass straight through: ./start.command --port 3090 --sandbox off --cli claude
set -euo pipefail
cd "$(dirname "$0")"

# The repository pins pnpm@11.7.0 (packageManager); its node_modules were installed with that version.
export PATH="/Users/dearglory/.local/pnpm-11.7.0/node_modules/.bin:$PATH"

if [ ! -d node_modules ]; then
  echo "node_modules is missing; installing with pnpm 11.7.0 ..."
  pnpm install --frozen-lockfile
fi

if [ ! -f lib/standalone.js ] || [ ! -f desktop/dist/index.html ]; then
  echo "lib/ or desktop/dist/ is missing; building ..."
  pnpm build
fi

exec node scripts/superagent.mjs --harnesses "$PWD/harnesses.json" "$@"
