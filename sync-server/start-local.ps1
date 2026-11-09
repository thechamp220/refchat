$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$tokenFile = Join-Path $bridgeRoot '.env.local'
if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) { throw 'sync-server/.env.local introuvable.' }
$tokenLine = Get-Content -LiteralPath $tokenFile | Where-Object { $_ -match '^CSG_TOKEN=' } | Select-Object -First 1
$bridgeTokenValue = if ($tokenLine) { $tokenLine.Substring(10).Trim() } else { '' }
if ($bridgeTokenValue.Length -lt 32) { throw 'Le jeton local doit contenir au moins 32 caractères.' }
$listener = Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) { throw 'Port 8788 is already in use; nothing was started.' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$serverPath = Join-Path $bridgeRoot 'server.mjs'
$env:CSG_TOKEN = $bridgeTokenValue
$env:CSG_BIND = '127.0.0.1'
$env:CSG_PORT = '8788'
$env:CSG_FILE = Join-Path $bridgeRoot 'data/snapshot.json'
$env:CSG_CODEX_BRIDGE = '1'
try {
  Start-Process -FilePath $nodePath -ArgumentList @('"' + $serverPath + '"') -WorkingDirectory $bridgeRoot -WindowStyle Hidden
} finally {
  Remove-Item Env:CSG_TOKEN, Env:CSG_BIND, Env:CSG_PORT, Env:CSG_FILE, Env:CSG_CODEX_BRIDGE -ErrorAction SilentlyContinue
}
'Codex local relay listening on 127.0.0.1:8788.'
