[CmdletBinding()]
param(
  [ValidateSet('install', 'start', 'stop', 'restart', 'diagnose', 'uninstall', 'repair', 'recover-web')]
  [string]$Action = 'diagnose',
  [string]$StateDir,
  [switch]$InterruptActive,
  [switch]$Relocate,
  [switch]$Source
)
$ErrorActionPreference = 'Stop'
$AgentRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$AgentScript = Join-Path $PSScriptRoot 'agent-install.mjs'
$AgentArgs = @($AgentScript, $Action, '--root', $AgentRoot)
if ($StateDir) { $AgentArgs += @('--state-dir', $StateDir) }
if ($InterruptActive) { $AgentArgs += '--interrupt-active' }
if ($Relocate) { $AgentArgs += '--relocate' }
if ($Source) { $AgentArgs += '--source' }
& node @AgentArgs
exit $LASTEXITCODE
