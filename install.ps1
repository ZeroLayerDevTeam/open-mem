# claude-open-mem installer for Windows (PowerShell 5.1+).
# Checks Node.js and Claude Code, adds the marketplace, checks the GPU BEFORE installing the plugin (asks when
# there is none), installs the plugin, then runs `setup` (Ollama + the model that fits the GPU; it asks first).
# Usage: irm https://raw.githubusercontent.com/ZeroLayerDevTeam/open-mem/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$Marketplace = 'ZeroLayerDevTeam/open-mem'

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js >= 22.13 is required: https://nodejs.org (then open a new terminal and run this again).' }
$v = (& node -p "process.versions.node").Split('.') | ForEach-Object { [int]$_ }
if ($v[0] -lt 22 -or ($v[0] -eq 22 -and $v[1] -lt 13)) { Fail "Node.js >= 22.13 is required, found $($v -join '.'): https://nodejs.org" }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Fail 'Claude Code (the `claude` command) is required: https://claude.com/claude-code' }

Write-Host 'Adding the claude-open-mem marketplace...'
& claude plugin marketplace add $Marketplace | Out-Host
$market = (& claude plugin marketplace list --json | ConvertFrom-Json) | Where-Object { $_.name -eq 'claude-open-mem' } | Select-Object -First 1
if (-not $market) { Fail 'The marketplace was not added; see the message above.' }

& node --no-warnings (Join-Path $market.installLocation 'src\cli.mjs') check
if ($LASTEXITCODE -eq 2) {
  $answer = Read-Host 'Install claude-open-mem anyway? [y/N]'
  if ($answer -notmatch '^(y|yes|s|si)$') { Write-Host 'Nothing installed.'; exit 0 }
}

& claude plugin install open-mem@claude-open-mem | Out-Host
$plugin = (& claude plugin list --json | ConvertFrom-Json) | Where-Object { $_.id -eq 'open-mem@claude-open-mem' } | Select-Object -First 1
if (-not $plugin) { Fail 'The plugin was not installed; see the message above.' }

& node --no-warnings (Join-Path $plugin.installPath 'src\cli.mjs') setup
Write-Host "`nDone. Restart Claude Code: the first session shows the web viewer address and its admin token once."
