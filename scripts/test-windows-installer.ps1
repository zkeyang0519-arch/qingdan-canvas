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
# The runner has no interactive desktop. Address the NSIS dialog on its
# own thread so the real wizard can run and be tested entirely off-screen.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public class WizardControl {
  public IntPtr Handle;
  public int Id;
  public string ClassName, Label;
  public bool Enabled, Radio, CheckBox;
  delegate bool Visit(IntPtr h, IntPtr ignored);
  [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint thread, Visit visit, IntPtr ignored);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, Visit visit, IntPtr ignored);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr h,int id);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h,int index);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder text,int capacity);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h,uint msg,IntPtr a,StringBuilder b,uint flags,uint ms,out IntPtr result);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h,uint msg,IntPtr a,string b);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h,uint msg,IntPtr a,IntPtr b);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint msg,IntPtr a,IntPtr b);
  static string ClassOf(IntPtr h) {
    var name=new StringBuilder(64);
    GetClassName(h,name,name.Capacity);
    return name.ToString();
  }
  public static List<WizardControl> Read(Process process) {
    IntPtr root=IntPtr.Zero;
    foreach (ProcessThread thread in process.Threads) {
      EnumThreadWindows((uint)thread.Id,(h,unused)=>{
        if(ClassOf(h)=="#32770" && GetDlgItem(h,1)!=IntPtr.Zero) { root=h; return false; }
        return true;
      },IntPtr.Zero);
      if(root!=IntPtr.Zero) break;
    }
    var result=new List<WizardControl>();
    if(root==IntPtr.Zero) return result;
    EnumChildWindows(root,(h,unused)=>{
      for(var parent=h; parent!=root && parent!=IntPtr.Zero; parent=GetParent(parent))
        if((GetWindowLong(parent,-16) & 0x10000000)==0) return true;
      string name=ClassOf(h);
      var label=new StringBuilder(512);
      if(name=="Button" || name=="Edit" || name=="Static")
        SendMessageTimeout(h,0xD,(IntPtr)label.Capacity,label,2,100,out var ignored);
      int kind=GetWindowLong(h,-16) & 15;
      result.Add(new WizardControl { Handle=h, ClassName=name, Label=label.ToString(), Id=GetDlgCtrlID(h),
        Enabled=IsWindowEnabled(h), Radio=name=="Button" && (kind==4 || kind==9),
        CheckBox=name=="Button" && (kind==2 || kind==3 || kind==5 || kind==6) });
      return true;
    },IntPtr.Zero);
    return result;
  }
  public void SetValue(string text) { SendMessage(Handle,0xC,IntPtr.Zero,text); }
  public void Check(bool value) { SendMessage(Handle,0xF1,(IntPtr)(value?1:0),IntPtr.Zero); }
  public void Click() { PostMessage(GetParent(Handle),0x111,(IntPtr)Id,Handle); }
}
'@
function Get-WizardControls($process) {
  $process.Refresh()
  if ($process.HasExited) { throw "Wizard exited early ($($process.ExitCode))." }
  [WizardControl]::Read($process)
}
function Test-Wizard([string]$mode, [string]$destination) {
  Write-Host "Testing $mode installation at $destination"
  $process = Start-Process -FilePath $setup -PassThru -WindowStyle Hidden
  $chosen = $false
  $sawDirectory = $false
  $sawProgress = $false
  $lastPage = ''
  $deadline = [datetime]::UtcNow.AddMinutes(3)
  try {
    while ([datetime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 120
      $controls = @(Get-WizardControls $process)
      $next = $controls | Where-Object { $_.Id -eq 1 -and $_.ClassName -eq 'Button' } | Select-Object -First 1
      if ($controls | Where-Object ClassName -eq 'msctls_progress32') {
        if (-not $sawProgress) { Write-Host 'Reached the installation progress page.' }
        $sawProgress = $true
      }
      if (-not $next -or -not $next.Enabled) { continue }
      $radios = @($controls | Where-Object Radio)
      $replace = $radios | Where-Object Label -match 'Replace the existing|覆盖已有版本' | Select-Object -First 1
      $change = $radios | Where-Object Label -match 'Move Qingdao|Remove the old program|更换安装位置' | Select-Object -First 1
      $currentUser = $radios | Where-Object { $_.Id -eq 1202 -and $_.Label -match 'Only for me|just for me|仅为我' } | Select-Object -First 1
      $dir = $controls | Where-Object { $_.Id -eq 1019 -and $_.ClassName -eq 'Edit' } | Select-Object -First 1
      $page = "$($next.Label)/$($replace.Handle)/$($dir.Handle)/$(($controls | Where-Object ClassName -eq '#32770').Handle -join ',')"
      if ($lastPage -eq $page) { continue }
      if ($replace) {
        if ($mode -eq 'first' -or -not $change) { throw 'Unexpected maintenance choices.' }
        $option = if ($mode -eq 'move') { $change } else { $replace }
        Write-Host "Choosing $($option.Label)"
        foreach ($radio in $radios) { $radio.Check($radio.Handle -eq $option.Handle) }
        $option.Click()
        Start-Sleep -Milliseconds 100
        $chosen = $true
      } elseif ($currentUser) {
        foreach ($radio in $radios) { $radio.Check($radio.Handle -eq $currentUser.Handle) }
        $currentUser.Click()
      } elseif ($dir) {
        Write-Host "Directory picker opened at $($dir.Label)"
        if ($mode -eq 'replace' -and $dir.Label -ne $destination) { throw "Overwrite lost its original directory: $($dir.Label)" }
        if ($mode -ne 'replace') { $dir.SetValue($destination) }
        $sawDirectory = $true
      } elseif ($next.Label -match 'Finish|完成') {
        Write-Host 'Reached the finish page.'
        foreach ($control in $controls | Where-Object CheckBox) { $control.Check($false) }
        $next.Click()
        if (-not $process.WaitForExit(10000) -or $process.ExitCode -ne 0) { throw 'Wizard failed to finish.' }
        if ($mode -ne 'first' -and -not $chosen) { throw 'No maintenance choice appeared.' }
        if ($mode -ne 'replace' -and -not $sawDirectory) { throw 'No directory picker appeared.' }
        if (-not $sawProgress) { throw 'No native installation progress appeared.' }
        return
      } elseif ($next.Label -notmatch 'Next|Install|下一步|安装') {
        continue
      }
      $lastPage = $page
      $next.Click()
      Start-Sleep -Milliseconds 180
    }
    throw "Wizard timed out during $mode. Controls: $(($controls.Label) -join ' / ')"
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
