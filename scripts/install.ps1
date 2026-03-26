# Fleet Commander Install (PowerShell wrapper)
# Delegates to install.sh via bash for cross-platform compatibility.
#
# Usage:
#   .\scripts\install.ps1 [[-TargetRepo] <path>]
#   .\scripts\install.ps1                        # auto-detects git repo root
#   .\scripts\install.ps1 C:\Git\my-project      # explicit target

param(
    [Parameter(Position = 0)]
    [string]$TargetRepo = ""
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($TargetRepo) {
    & bash "$scriptDir/install.sh" "$TargetRepo"
} else {
    & bash "$scriptDir/install.sh"
}

exit $LASTEXITCODE
