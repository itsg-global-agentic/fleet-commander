# Fleet Commander Uninstall (PowerShell wrapper)
# Delegates to uninstall.sh via bash for cross-platform compatibility.
#
# Usage:
#   .\scripts\uninstall.ps1 [[-TargetRepo] <path>]
#   .\scripts\uninstall.ps1                        # auto-detects git repo root
#   .\scripts\uninstall.ps1 C:\Git\my-project      # explicit target

param(
    [Parameter(Position = 0)]
    [string]$TargetRepo = ""
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($TargetRepo) {
    & bash "$scriptDir/uninstall.sh" "$TargetRepo"
} else {
    & bash "$scriptDir/uninstall.sh"
}

exit $LASTEXITCODE
