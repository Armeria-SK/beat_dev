#!/usr/bin/env bash
# Usage: ./start.sh [--install] [--no-build] [--] [app args, e.g. --data-dir <dir>]
# Checks Node, installs dependencies when needed, builds the web UI, then runs the server in the foreground.
set -euo pipefail
cd "$(dirname "$0")"

install=0
build=1
while [ $# -gt 0 ]; do
  case "$1" in
    --install) install=1; shift ;;
    --no-build) build=0; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install the version listed in package.json (engines.node) and try again." >&2
  exit 1
fi
node -e 'const p=JSON.parse(require(`fs`).readFileSync(`package.json`,`utf8`));const w=((p.engines&&p.engines.node)||``).replace(/[^0-9.]/g,``);const r=w.split(`.`).map(Number);const v=process.versions.node.split(`.`).map(Number);for(let i=0;i<3;i++){const a=v[i]||0,b=r[i]||0;if(a>b)break;if(a<b){console.error(`Node.js ${w} or newer is required (found ${process.versions.node}).`);process.exit(1)}}'

if [ -f package-lock.json ]; then
  if [ "$install" = 1 ] || [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    npm ci
  fi
elif [ "$install" = 1 ] || [ ! -d node_modules ]; then
  npm install
fi

if [ "$build" = 1 ]; then
  npm run build:web
fi

exec node src/main.ts "$@"
