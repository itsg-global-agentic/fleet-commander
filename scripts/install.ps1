# Fleet Commander Install (PowerShell wrapper)
# Delegates to install.sh via bash for cross-platform compatibility.
#
# Usage:
#   .\scripts\install.ps1 [[-TargetRepo] <path>] [-Mode <http|bash>] [-Port <int>]
#   .\scripts\install.ps1                            # auto-detects git repo root, mode=http, port=4680
#   .\scripts\install.ps1 C:\Git\my-project          # explicit target
#   .\scripts\install.ps1 -Mode bash                 # legacy bash hooks
#   .\scripts\install.ps1 -Mode http -Port 4681      # custom FC port

param(
    [Parameter(Position = 0)]
    [string]$TargetRepo = "",

    [ValidateSet('http', 'bash')]
    [string]$Mode = "http",

    [int]$Port = 0
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Build the argument list forwarded to install.sh. We always pass --mode so
# the wrapper's default matches install.sh's. --port is only forwarded when
# the caller explicitly set it (0 = unset) so install.sh's $FLEET_PORT
# fallback continues to work.
$bashArgs = @("$scriptDir/install.sh", "--mode", $Mode)
if ($Port -gt 0) {
    $bashArgs += @("--port", "$Port")
}
if ($TargetRepo) {
    $bashArgs += $TargetRepo
}

& bash @bashArgs

exit $LASTEXITCODE
