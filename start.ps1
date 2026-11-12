# Usage: .\start.ps1 [-Install] [-NoBuild] [app args, e.g. --data-dir <dir>]
# Checks Node, installs dependencies when needed, builds the web UI, then runs the server in the foreground.
param(
  [switch]$Install,
  [switch]$NoBuild,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$AppArgs = @()
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Invoke-Step([string]$Exe, [string[]]$Arguments) {
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js was not found. Install the version listed in package.json (engines.node) and try again.' -ForegroundColor Red
  exit 1
}
Invoke-Step node @('-e', 'const p=JSON.parse(require(`fs`).readFileSync(`package.json`,`utf8`));const w=((p.engines&&p.engines.node)||``).replace(/[^0-9.]/g,``);const r=w.split(`.`).map(Number);const v=process.versions.node.split(`.`).map(Number);for(let i=0;i<3;i++){const a=v[i]||0,b=r[i]||0;if(a>b)break;if(a<b){console.error(`Node.js ${w} or newer is required (found ${process.versions.node}).`);process.exit(1)}}')

$marker = 'node_modules/.package-lock.json'
if (Test-Path 'package-lock.json') {
  if ($Install -or -not (Test-Path $marker) -or (Get-Item 'package-lock.json').LastWriteTime -gt (Get-Item $marker).LastWriteTime) {
    Invoke-Step npm @('ci')
  }
} elseif ($Install -or -not (Test-Path 'node_modules')) {
  Invoke-Step npm @('install')
}

if (-not $NoBuild) {
  Invoke-Step npm @('run', 'build:web')
}

& node src/main.ts @AppArgs
exit $LASTEXITCODE
