<#
.SYNOPSIS
  Validación end-to-end real: levanta/actualiza todo con setup.ps1 y ejecuta scripts/e2e.mjs.
  Requiere el stack recon-m0 (API en 127.0.0.1:18180) y Ollama con qwen2.5:7b.
#>
[CmdletBinding()]
param([switch]$SkipSetup)
. (Join-Path $PSScriptRoot 'lib.ps1')
Push-Location $script:Root
try {
    if (-not (Test-Path node_modules/playwright)) { npm install --no-fund --no-audit | Out-Null }
    if (-not $SkipSetup) { & (Join-Path $PSScriptRoot 'setup.ps1') }
    node scripts/e2e.mjs
    if ($LASTEXITCODE -ne 0) { throw "e2e falló (ver evidence/e2e-summary.json)" }
} finally { Pop-Location }
