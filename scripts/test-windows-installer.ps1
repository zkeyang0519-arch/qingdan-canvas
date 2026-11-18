# Exercise the published wizard on a disposable Windows runner. The test installs
# a real copy, then reopens setup in maintenance mode with a simulated older version.
param(
  [Parameter(Mandatory)][ValidateSet('original', 'preview')][string]$Channel,
  [Parameter(Mandatory)][string]$Installer
)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP) {
  throw 'Run the installation test on a disposable GitHub-hosted Windows runner.'
}
$setup = (Get-Item -LiteralPath $Installer).FullName
$folder = Join-Path $env:RUNNER_TEMP "轻岛 QA $Channel"
$moved = Join-Path $env:RUNNER_TEMP "轻岛 moved $Channel"
if ($Channel -eq 'original') {
  $binary = 'Qingdao.exe'
  $scheme = 'qingdao'
  $uninstall = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ac3646b8-59ba-589d-9c6f-4c69eeeddcf0'
} else {
  $binary = 'qingdao-preview.exe'
  $scheme = 'qingdao-preview'
  $uninstall = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Qingdao Preview'
}
if ((Test-Path -LiteralPath $uninstall) -or (Test-Path -LiteralPath $folder) -or (Test-Path -LiteralPath $moved)) {
  throw 'The isolated installation requires an unused directory and registry entry.'
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WizardButton {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  public static void Click(int hwnd) { PostMessage((IntPtr)hwnd, 0xF5, IntPtr.Zero, IntPtr.Zero); }
}
'@
function Get-WizardControls($process) {
  $process.Refresh()
  if ($process.HasExited) { throw "Wizard exited early ($($process.ExitCode))." }
  if ($process.MainWindowHandle -eq 0) { return }
  $dialog = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  $controls = $dialog.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
  foreach ($control in $controls) {
    if (-not $control.Current.IsOffscreen) { $control }
  }
}
function Test-Wizard([string]$mode, [string]$destination) {
  $process = Start-Process -FilePath $setup -PassThru -WindowStyle Hidden
  $chosen = $false
  $sawDirectory = $false
  $sawProgress = $false
  $deadline = [datetime]::UtcNow.AddMinutes(3)
  try {
    while ([datetime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 120
      $controls = @(Get-WizardControls $process)
      $next = $controls | Where-Object { $_.Current.AutomationId -eq '1' -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button } | Select-Object -First 1
      if ($controls | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::ProgressBar }) {
        $sawProgress = $true
      }
      if (-not $next -or -not $next.Current.IsEnabled) { continue }
      $radios = @($controls | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::RadioButton })
      $replace = $radios | Where-Object { $_.Current.Name -match 'Replace the existing|覆盖已有版本' } | Select-Object -First 1
      $change = $radios | Where-Object { $_.Current.Name -match 'Move Qingdao|Remove the old program|更换安装位置' } | Select-Object -First 1
      $dir = $controls | Where-Object { $_.Current.AutomationId -eq '1019' -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::Edit } | Select-Object -First 1
      if ($replace) {
        if ($mode -eq 'first' -or -not $change) { throw 'Unexpected maintenance choices.' }
        $option = if ($mode -eq 'move') { $change } else { $replace }
        [WizardButton]::Click($option.Current.NativeWindowHandle)
        Start-Sleep -Milliseconds 100
        $chosen = $true
      } elseif ($dir) {
        $field = $dir.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
        if ($mode -eq 'replace' -and $field.Current.Value -ne $destination) { throw "Overwrite lost its original directory: $($field.Current.Value)" }
        if ($mode -ne 'replace') { $field.SetValue($destination) }
        $sawDirectory = $true
      } elseif ($next.Current.Name -match 'Finish|完成') {
        foreach ($control in $controls | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::CheckBox }) {
          $toggle = $control.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
          if ($toggle.Current.ToggleState -eq [Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
        }
        [WizardButton]::Click($next.Current.NativeWindowHandle)
        if (-not $process.WaitForExit(10000) -or $process.ExitCode -ne 0) { throw 'Wizard failed to finish.' }
        if ($mode -ne 'first' -and -not $chosen) { throw 'No maintenance choice appeared.' }
        if ($mode -ne 'replace' -and -not $sawDirectory) { throw 'No directory picker appeared.' }
        if (-not $sawProgress) { throw 'No native installation progress appeared.' }
        return
      } elseif ($next.Current.Name -notmatch 'Next|Install|下一步|安装') {
        continue
      }
      [WizardButton]::Click($next.Current.NativeWindowHandle)
      Start-Sleep -Milliseconds 180
    }
    throw "Wizard timed out during $mode. Visible controls: $(($controls | ForEach-Object { $_.Current.Name }) -join ' / ')"
  } finally {
    if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $process.Dispose()
  }
}
function Assert-Installed([string]$destination) {
  $locationKey = if ($Channel -eq 'original') { 'HKCU:\Software\ac3646b8-59ba-589d-9c6f-4c69eeeddcf0' } else { $uninstall }
  $registered = (Get-ItemPropertyValue -LiteralPath $locationKey -Name InstallLocation).Trim('"')
  $exe = Join-Path $destination $binary
  $handler = (Get-Item -LiteralPath "HKCU:\Software\Classes\$scheme\shell\open\command").GetValue('')
  if ($registered -ne $destination -or -not (Test-Path -LiteralPath $exe -PathType Leaf) -or -not $handler.Contains($exe)) {
    throw "Installed binary, registered directory or protocol does not match $destination."
  }
}
Test-Wizard 'first' $folder
Assert-Installed $folder
Set-ItemProperty -LiteralPath $uninstall -Name DisplayVersion -Value '0.0.1'
Test-Wizard 'replace' $folder
Assert-Installed $folder
if ($Channel -eq 'original') {
  Test-Wizard 'move' $moved
  Assert-Installed $moved
  if (Test-Path -LiteralPath (Join-Path $folder $binary)) { throw 'Old executable remained after moving the installation.' }
}
Write-Host "Verified $Channel installation, custom folder, maintenance radio buttons, progress and protocol."
