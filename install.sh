#!/usr/bin/env sh
# claude-open-mem installer for Linux and macOS.
# Checks Node.js and Claude Code, adds the marketplace, checks the GPU BEFORE installing the plugin (asks when
# there is none), installs the plugin, then runs `setup` (Ollama + the model that fits the GPU; it asks first).
# Usage: curl -fsSL https://raw.githubusercontent.com/ZeroLayerDevTeam/open-mem/main/install.sh | sh
set -eu
MARKETPLACE=ZeroLayerDevTeam/open-mem

fail() { printf '%s\n' "$1" >&2; exit 1; }
# Questions read the terminal, so they also work when the script comes through a pipe.
ask() { printf '%s [y/N] ' "$1"; read -r a </dev/tty || a=''; case "$a" in y|Y|yes|s|si) return 0 ;; *) return 1 ;; esac; }

command -v node >/dev/null 2>&1 || fail 'Node.js >= 22.13 is required: https://nodejs.org'
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || fail "Node.js >= 22.13 is required, found $(node -v): https://nodejs.org"
command -v claude >/dev/null 2>&1 || fail 'Claude Code (the `claude` command) is required: https://claude.com/claude-code'

echo 'Adding the claude-open-mem marketplace...'
claude plugin marketplace add "$MARKETPLACE"
field() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const x=JSON.parse(d).find(e=>e[process.argv[1]]===process.argv[2]);process.stdout.write(x?x[process.argv[3]]:"")})' "$@"; }
MARKET=$(claude plugin marketplace list --json | field name claude-open-mem installLocation)
[ -n "$MARKET" ] || fail 'The marketplace was not added; see the message above.'

code=0
node --no-warnings "$MARKET/src/cli.mjs" check || code=$?
if [ "$code" -eq 2 ]; then
  ask 'Install claude-open-mem anyway?' || { echo 'Nothing installed.'; exit 0; }
fi

claude plugin install open-mem@claude-open-mem
PLUGIN=$(claude plugin list --json | field id open-mem@claude-open-mem installPath)
[ -n "$PLUGIN" ] || fail 'The plugin was not installed; see the message above.'

node --no-warnings "$PLUGIN/src/cli.mjs" setup </dev/tty || true
printf '\nDone. Restart Claude Code: the first session shows the web viewer address and its admin token once.\n'
