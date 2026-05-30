<#
.SYNOPSIS
Remove the Secretary gateway Windows service installed via NSSM.

.PARAMETER ServiceName
Service name to remove. Default: secretary-gateway.

.PARAMETER NssmExe
Path or command for nssm.exe. Default: 'nssm'.
#>

[CmdletBinding()]
param(
  [string]$ServiceName = 'secretary-gateway',
  [string]$NssmExe = 'nssm'
)

$ErrorActionPreference = 'Stop'

Write-Host "Stopping '$ServiceName'..."
& $NssmExe stop $ServiceName 2>$null | Out-Null

Write-Host "Removing '$ServiceName'..."
& $NssmExe remove $ServiceName confirm
if ($LASTEXITCODE -ne 0) { throw "nssm remove failed (exit $LASTEXITCODE)." }

Write-Host "Service '$ServiceName' removed."
