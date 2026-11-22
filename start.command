#!/bin/bash
# One-click start for the GlorySuperAgent desktop app.
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

# The router CLI and the workers come from harnesses.json; a ticket that names none runs its default.
exec pnpm start --cli "${SUPERAGENT_CLI:-claude}" --harnesses "$PWD/harnesses.json" "$@"
