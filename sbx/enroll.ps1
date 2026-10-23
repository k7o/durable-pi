#Requires -Version 7.0
<#
.SYNOPSIS
Host side of the device kit, for a Windows host: copy one device's bearer token out of its sandbox
and into the hub registry on this machine.

  pwsh ./sbx/enroll.ps1 <device-id> <sandbox-name>

The PowerShell 7 counterpart of sbx/enroll.sh; read that file for the reasoning, which is
identical. This one exists because a Windows host has no bash, and because two details are
platform specifics rather than policy:

  * the token is still read by running a POSIX pipeline inside the sandbox (Linux), but the
    quoting around it is PowerShell's, so the remote script deliberately contains no quotes at
    all -- PowerShell on Windows still re-quotes native arguments, and a quote-free argument
    survives every mode of $PSNativeCommandArgumentPassing;
  * a checkout's tsx is node_modules/.bin/tsx.cmd on Windows, not the extension-less shell script,
    and the extension-less one is not executable here. npx is the fallback as before, and DPI_TSX
    overrides both for a checkout whose node_modules live somewhere else.

This is the step no kit can do. A kit turns one sandbox into one device and generates that
device's token inside it; joining a device to a network means moving the token across a sandbox
boundary, which is a host-side act. Run it from the durable-pi checkout, or from an environment
file's lifecycle.postCreate hook, which passes the sandbox name as SBX_SANDBOX_NAME (expand it in
whatever shell sbx runs host commands with):

  lifecycle:
    postCreate:
      - name: Enroll the device with the hub
        command: pwsh -NoProfile -File C:/path/to/durable-pi/sbx/enroll.ps1 "$SBX_SANDBOX_NAME" "$SBX_SANDBOX_NAME"

The device has to be declared in dpi-network.yaml as `kind: url` first -- the URL is a choice
(which host port you published, and whether the hub reaches it as 127.0.0.1 or
host.docker.internal) and this script will not guess it. When the id is missing, the script prints
what to add and exits 0, so a postCreate hook never fails a create over it.

Re-running is safe: register replaces the stored token and forgets the old device uid, which is
what a recreated sandbox needs (new token, new identity, same device id).
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$DeviceId,
    [Parameter(Position = 1)][string]$Sandbox
)

$ErrorActionPreference = 'Stop'
# 7.3+: a nonzero native exit code must stay a value we test, not a terminating error, because the
# final `net status` is allowed to fail (the device may still be booting).
if (Test-Path Variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Write-Err {
    param([string]$Message)
    [Console]::Error.WriteLine($Message)
}

if ([string]::IsNullOrWhiteSpace($DeviceId) -or [string]::IsNullOrWhiteSpace($Sandbox)) {
    Write-Err 'usage: sbx/enroll.ps1 <device-id> <sandbox-name>'
    exit 2
}

# The checkout root is the git top level; outside a repo (a copied script, a hook run from
# somewhere else) it is the parent of sbx/.
function Get-CheckoutRoot {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $top = $null
    try {
        if (Get-Command git -CommandType Application -ErrorAction Ignore) {
            $top = & git rev-parse --show-toplevel 2>$null
            if ($LASTEXITCODE -ne 0) { $top = $null }
        }
    } catch {
        # git is missing or refused to answer; the script's own location is the fallback.
        $top = $null
    } finally {
        $ErrorActionPreference = $previous
    }
    $first = @($top)[0]
    if ($first) { return ([string]$first).Trim() }
    return (Split-Path -Parent $PSScriptRoot)
}

$root = Get-CheckoutRoot

# DPI_NETWORK_FILE overrides the file. Resolve it the way Node's path.resolve does for net.ts --
# against the current directory, no tilde expansion -- so this check and net.ts read the same file.
if ($env:DPI_NETWORK_FILE) {
    $networkFile = $env:DPI_NETWORK_FILE
    if (-not [System.IO.Path]::IsPathRooted($networkFile)) {
        $networkFile = Join-Path $PWD.ProviderPath $networkFile
    }
    $networkFile = [System.IO.Path]::GetFullPath($networkFile)
} else {
    $networkFile = [System.IO.Path]::Combine($root, 'dpi-network.yaml')
}

if (-not (Test-Path -LiteralPath $networkFile -PathType Leaf)) {
    Write-Err ('enroll: {0} does not exist; nothing to register into' -f $networkFile)
    exit 0
}

$declared = $false
$pattern = '^  ' + [regex]::Escape($DeviceId) + ':'
foreach ($line in [System.IO.File]::ReadAllLines($networkFile)) {
    if ($line -match $pattern) { $declared = $true; break }
}

if (-not $declared) {
    Write-Err @"
enroll: $DeviceId is not declared in $networkFile. Add it, then re-run:

  devices:
    ${DeviceId}:
      kind: url
      url: http://127.0.0.1:<host-port>     # or http://host.docker.internal:<host-port> when the hub runs in another sandbox

and publish the device's port on the host. The hub runs on this host, so loopback is enough:

  sbx ports $Sandbox --publish 4780:4780/tcp

Use --publish 0.0.0.0:<host-port>:4780/tcp only if the hub cannot reach the loopback publish.
"@
    exit 0
}

if (-not (Get-Command sbx -CommandType Application -ErrorAction Ignore)) {
    Write-Err 'enroll: sbx is not on PATH'
    exit 1
}

# The token lives in the device's own ~/.dpi/backend.env, mode 600. Read it over the sandbox
# boundary without echoing it anywhere else. No quotes inside this string on purpose: it is handed
# to `sh -c` in the sandbox as one native argument, and a quote-free argument needs no re-quoting.
$remote = 'grep ^DPI_TOKEN= $HOME/.dpi/backend.env | head -1 | cut -d= -f2-'
$lines = @(& sbx exec $Sandbox sh -c $remote)
$token = (($lines | ForEach-Object { [string]$_ }) -join '').Trim()

if ($token.Length -lt 32) {
    Write-Err ('enroll: no token in {0}:~/.dpi/backend.env (is the backend up? try `sbx exec {0} durable status`)' -f $Sandbox)
    exit 1
}

Set-Location -LiteralPath $root

# Prefer the checkout's own tsx so enrollment works offline and without npx's cache. On Windows the
# launcher is tsx.cmd (or tsx.ps1); the extension-less tsx beside it is a sh script and does not run.
# DPI_TSX names a launcher to use instead of either lookup.
$appDirs = @('apps/dpi-sdk', 'apps/proactive-dpi-demo')
$tsx = $null
if ($env:DPI_TSX) {
    if (-not (Test-Path -LiteralPath $env:DPI_TSX -PathType Leaf)) {
        Write-Err ('enroll: DPI_TSX is set to {0}, which is not a file' -f $env:DPI_TSX)
        exit 1
    }
    $tsx = $env:DPI_TSX
} else {
    foreach ($app in $appDirs) {
        foreach ($launcher in @('tsx.cmd', 'tsx.ps1')) {
            $candidate = Join-Path $root (Join-Path $app "node_modules/.bin/$launcher")
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $tsx = $candidate; break }
        }
        if ($tsx) { break }
    }
}

$npx = $null
foreach ($npxName in @('npx.cmd', 'npx.ps1', 'npx')) {
    $npx = Get-Command $npxName -CommandType Application, ExternalScript -ErrorAction Ignore
    if ($npx) { break }
}

if (-not $tsx -and -not $npx) {
    # Name the half that is missing: "no tsx and no npx" hides whether Node is installed at all.
    $nodeVersion = 'not on PATH'
    $npmVersion = 'not on PATH'
    if (Get-Command node -CommandType Application -ErrorAction Ignore) { $nodeVersion = ((& node -v 2>$null) | Select-Object -First 1) }
    if (Get-Command npm.cmd -CommandType Application -ErrorAction Ignore) { $npmVersion = ((& npm.cmd -v 2>$null) | Select-Object -First 1) }
    $checked = ($appDirs | ForEach-Object { Join-Path $root (Join-Path $_ 'node_modules/.bin') }) -join '; '
    $displayRoot = ($root -replace '\\', '/')
    Write-Err @"
enroll: cannot run apps/dpi-sdk/scripts/net.ts -- no tsx launcher in this checkout and no npx on PATH.
  node on PATH:  $nodeVersion
  npm on PATH:   $npmVersion
  looked in:     $($checked -replace '\\', '/')

Fix one of these, then re-run:
  * install Node 24 if node/npm are missing above (winget install OpenJS.NodeJS.LTS), reopen the terminal
  * cd "$displayRoot/apps/dpi-sdk"; npm ci     # installs tsx; needs Node 22.5+ for node:sqlite
  * `$env:DPI_TSX = 'C:\path\to\tsx.cmd'       # or point at a tsx launcher you already have
"@
    exit 1
}

$netScript = Join-Path $root 'apps/dpi-sdk/scripts/net.ts'
$script:netExit = 0

function Invoke-Net {
    # -NetArgs, not a positional call: a bare `--token` argument is parsed as a parameter name,
    # which binds to nothing here and fails before net.ts ever runs.
    param([string[]]$NetArgs)
    if ($tsx) {
        & $tsx $netScript @NetArgs
    } else {
        & $npx.Path --yes tsx $netScript @NetArgs
    }
    $script:netExit = $LASTEXITCODE
}

$savedWarnings = $env:NODE_NO_WARNINGS
$env:NODE_NO_WARNINGS = '1'
try {
    Invoke-Net -NetArgs @('register', $DeviceId, '--token', $token)
    if ($script:netExit -ne 0) { exit $script:netExit }

    # Status is informational: at postCreate time the device may still be booting, and net status
    # exits 2 for anything not yet online, which would fail the sandbox create.
    Invoke-Net -NetArgs @('status', $DeviceId)
} finally {
    if ($null -eq $savedWarnings) {
        Remove-Item Env:NODE_NO_WARNINGS -ErrorAction Ignore
    } else {
        $env:NODE_NO_WARNINGS = $savedWarnings
    }
}

exit 0
