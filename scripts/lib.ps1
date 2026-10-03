# Funciones compartidas por setup.ps1 y e2e.ps1 (PowerShell 7+).
$ErrorActionPreference = 'Stop'
$script:Root = Split-Path -Parent $PSScriptRoot

function Read-DotEnv([string]$Path = (Join-Path $script:Root '.env')) {
    $map = [ordered]@{}
    if (-not (Test-Path $Path)) { return $map }
    foreach ($line in Get-Content $Path) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $k, $v = $line -split '=', 2
        $map[$k.Trim()] = $v.Trim()
    }
    return $map
}

function Set-DotEnvValue([string]$Key, [string]$Value, [string]$Path = (Join-Path $script:Root '.env')) {
    $lines = @(Get-Content $Path)
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*$([regex]::Escape($Key))=") { $lines[$i] = "$Key=$Value"; $found = $true }
    }
    if (-not $found) { $lines += "$Key=$Value" }
    Set-Content -Path $Path -Value $lines -Encoding utf8NoBOM
}

function New-RandomHex([int]$Bytes = 32) {
    $b = [byte[]]::new($Bytes)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($b)
    return ([System.BitConverter]::ToString($b) -replace '-', '').ToLowerInvariant()
}

function New-TestPassword {
    # Cumple la política de n8n (>= 8, mayúscula, número). Sólo para la instancia local.
    return 'Lc' + (New-RandomHex 9) + '7Q'
}

function Wait-Http([string]$Url, [int]$TimeoutSec = 120) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $Url -SkipHttpErrorCheck -TimeoutSec 5
            if ($r.StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Seconds 2
    }
    throw "timeout esperando $Url"
}

function Invoke-Compose([string[]]$ComposeArgs) {
    Push-Location $script:Root
    try {
        & docker compose @ComposeArgs
        if ($LASTEXITCODE -ne 0) { throw "docker compose $($ComposeArgs -join ' ') falló ($LASTEXITCODE)" }
    } finally { Pop-Location }
}

function Get-N8nSession($EnvMap) {
    $base = "http://localhost:$($EnvMap.N8N_HOST_PORT)"
    # n8n ata la cookie de sesión a un encabezado browser-id. La cookie es Secure, y .NET no la
    # reenvía por http aunque sea localhost, así que se arma el encabezado Cookie a mano.
    $browserId = [guid]::NewGuid().ToString()
    $body = @{ emailOrLdapLoginId = $EnvMap.N8N_OWNER_EMAIL; password = $EnvMap.N8N_OWNER_PASSWORD } | ConvertTo-Json
    $r = Invoke-WebRequest -Method Post -Uri "$base/rest/login" -Body $body -ContentType 'application/json' -Headers @{ 'browser-id' = $browserId }
    $cookie = ($r.Headers['Set-Cookie'] | Where-Object { $_ -like 'n8n-auth=*' } | Select-Object -First 1) -replace ';.*$', ''
    return @{ 'browser-id' = $browserId; Cookie = $cookie }
}
