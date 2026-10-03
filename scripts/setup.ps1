<#
.SYNOPSIS
  Levanta n8n + Mailpit, crea la cuenta owner local de prueba, importa credenciales y
  workflows, y publica (activa) los workflows. Idempotente: se puede correr varias veces.

.NOTES
  - .env se crea desde .env.example con valores generados (clave de cifrado, contraseña de
    prueba). Nunca se usan credenciales reales.
  - La credencial JWT se arma desde la clave privada de desarrollo del proyecto de
    conciliación (RECON_DEV_KEYS_DIR), se importa cifrada en n8n y el archivo temporal se borra.
#>
[CmdletBinding()]
param([switch]$SkipUp)

. (Join-Path $PSScriptRoot 'lib.ps1')
$root = $script:Root
$envPath = Join-Path $root '.env'

# 1. .env con secretos de desarrollo generados -------------------------------------------
if (-not (Test-Path $envPath)) {
    Copy-Item (Join-Path $root '.env.example') $envPath
    Write-Host '[setup] .env creado desde .env.example'
}
$envMap = Read-DotEnv
if (-not $envMap.N8N_ENCRYPTION_KEY) { Set-DotEnvValue N8N_ENCRYPTION_KEY (New-RandomHex 32) }
if (-not $envMap.N8N_OWNER_PASSWORD) { Set-DotEnvValue N8N_OWNER_PASSWORD (New-TestPassword) }
$keysDir = $envMap.RECON_DEV_KEYS_DIR
if (-not [System.IO.Path]::IsPathRooted($keysDir)) { $keysDir = Join-Path $root $keysDir }
$jwksPath = Join-Path $keysDir 'public/jwks.json'
$pemPath = Join-Path $keysDir 'private.pem'
if (-not (Test-Path $jwksPath) -or -not (Test-Path $pemPath)) {
    throw "No encuentro las claves de desarrollo en $keysDir (corre 'uv run python scripts/dev_auth.py init' en el proyecto de conciliación)"
}
$kid = (Get-Content $jwksPath -Raw | ConvertFrom-Json).keys[0].kid
Set-DotEnvValue RECON_JWT_KID $kid
$envMap = Read-DotEnv
$base = "http://localhost:$($envMap.N8N_HOST_PORT)"

# 2. Contenedores --------------------------------------------------------------------------
if (-not $SkipUp) {
    Invoke-Compose @('up', '-d', '--wait')
}
Wait-Http "$base/healthz/readiness" 180
Write-Host "[setup] n8n listo en $base"

# 3. Owner local de prueba ----------------------------------------------------------------
$settings = Invoke-RestMethod "$base/rest/settings"
if ($settings.data.userManagement.showSetupOnFirstLoad) {
    $owner = @{ email = $envMap.N8N_OWNER_EMAIL; firstName = 'Owner'; lastName = 'Local'; password = $envMap.N8N_OWNER_PASSWORD } | ConvertTo-Json
    $null = Invoke-RestMethod -Method Post -Uri "$base/rest/owner/setup" -Body $owner -ContentType 'application/json'
    Write-Host '[setup] cuenta owner local creada (credenciales sólo en .env)'
}
$session = Get-N8nSession $envMap

# 4. API key para el e2e (API pública de n8n) ------------------------------------------------
$keyOk = $false
if ($envMap.N8N_API_KEY) {
    $probe = Invoke-WebRequest -Uri "$base/api/v1/workflows?limit=1" -Headers @{ 'X-N8N-API-KEY' = $envMap.N8N_API_KEY } -SkipHttpErrorCheck
    $keyOk = $probe.StatusCode -eq 200
}
if (-not $keyOk) {
    $scopes = (Invoke-RestMethod -Uri "$base/rest/api-keys/scopes" -Headers $session).data
    $req = @{ label = "e2e-local-$(Get-Date -Format yyyyMMddHHmmss)"; scopes = $scopes; expiresAt = $null } | ConvertTo-Json
    $created = Invoke-RestMethod -Method Post -Uri "$base/rest/api-keys" -Body $req -ContentType 'application/json' -Headers $session
    Set-DotEnvValue N8N_API_KEY $created.data.rawApiKey
    $envMap = Read-DotEnv
    Write-Host '[setup] API key local creada (guardada en .env)'
}

# 5. Credenciales (JWT de desarrollo + SMTP Mailpit), importadas cifradas ----------------------
$tmpDir = Join-Path $root '.tmp'
New-Item -ItemType Directory -Force $tmpDir | Out-Null
$credFile = Join-Path $tmpDir 'credentials.json'
try {
    $creds = @(
        @{ id = 'reconJwtDevKey01'; name = 'Recon API - JWT dev (RS256)'; type = 'jwtAuth'
           data = @{ keyType = 'pemKey'; privateKey = (Get-Content $pemPath -Raw); publicKey = ''; algorithm = 'RS256' } },
        @{ id = 'mailpitSmtpLocal1'; name = 'Mailpit SMTP local'; type = 'smtp'
           data = @{ user = ''; password = ''; host = 'mailpit'; port = 1025; secure = $false; disableStartTls = $true } }
    )
    ConvertTo-Json -InputObject $creds -Depth 5 | Set-Content -Path $credFile -Encoding utf8NoBOM
    Invoke-Compose @('cp', $credFile, 'n8n:/tmp/credentials.json')
    Invoke-Compose @('exec', '-T', 'n8n', 'n8n', 'import:credentials', '--input=/tmp/credentials.json')
} finally {
    Remove-Item $credFile -Force -ErrorAction SilentlyContinue
    Push-Location $root; docker compose exec -T -u root n8n rm -f /tmp/credentials.json | Out-Null; Pop-Location
}
Write-Host '[setup] credenciales importadas (archivo temporal borrado)'

# 6. Workflows -------------------------------------------------------------------------------
Invoke-Compose @('exec', '-T', '-u', 'root', 'n8n', 'sh', '-c', 'rm -rf /tmp/workflows && mkdir -p /tmp/workflows')
Get-ChildItem (Join-Path $root 'workflows') -Filter *.json | ForEach-Object {
    Invoke-Compose @('cp', $_.FullName, "n8n:/tmp/workflows/$($_.Name)")
}
Invoke-Compose @('exec', '-T', 'n8n', 'n8n', 'import:workflow', '--separate', '--input=/tmp/workflows')
$ids = Get-ChildItem (Join-Path $root 'workflows') -Filter *.json | ForEach-Object { (Get-Content $_.FullName -Raw | ConvertFrom-Json).id }
foreach ($id in $ids) {
    Invoke-Compose @('exec', '-T', 'n8n', 'n8n', 'publish:workflow', "--id=$id")
}
Invoke-Compose @('restart', 'n8n')
Wait-Http "$base/healthz/readiness" 180
Write-Host "[setup] workflows importados y publicados: $($ids -join ', ')"
Write-Host "[setup] Editor: $base  |  Mailpit: http://127.0.0.1:$($envMap.MAILPIT_UI_PORT)"

