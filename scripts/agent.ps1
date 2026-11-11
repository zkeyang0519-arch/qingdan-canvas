[CmdletBinding()]
param(
  [ValidateSet('install', 'start', 'stop', 'restart', 'diagnose', 'uninstall')]
  [string]$Action = 'diagnose',
  [string]$StateDir,
  [switch]$InterruptActive
)
$ErrorActionPreference = 'Stop'
$AgentRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$AgentScript = Join-Path $PSScriptRoot 'agent-install.mjs'
$AgentArgs = @($AgentScript, $Action, '--root', $AgentRoot)
if ($StateDir) { $AgentArgs += @('--state-dir', $StateDir) }
if ($InterruptActive) { $AgentArgs += '--interrupt-active' }
& node @AgentArgs
exit $LASTEXITCODE
