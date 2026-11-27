"use strict";

// A product feature, invoked only by a trusted, user-initiated desktop IPC.
// Inspect browser chrome only: stop traversal at each web Document. Never read
// page text, cookies, profiles or debugging ports, and never send keystrokes.
// The target travels separately in the child environment, not as shell code.
const windowsWorkspaceFocus = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type -ReferencedAssemblies UIAutomationClient,UIAutomationTypes,WindowsBase -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public static class QingdaoWorkspaceFocus {
  delegate bool WindowCallback(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr state);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int length);
  static readonly HashSet<string> Browsers = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
    "msedge", "chrome", "brave", "firefox", "vivaldi", "opera", "arc"
  };

  sealed class Chrome {
    public List<AutomationElement> Tabs = new List<AutomationElement>();
    public List<AutomationElement> Addresses = new List<AutomationElement>();
    public bool Complete = true;
  }

  static Chrome ReadChrome(IntPtr window) {
    Chrome result = new Chrome();
    Queue<AutomationElement> pending = new Queue<AutomationElement>();
    pending.Enqueue(AutomationElement.FromHandle(window));
    TreeWalker walker = TreeWalker.ControlViewWalker;
    int visited = 0;
    while (pending.Count > 0) {
      if (++visited > 1600) { result.Complete = false; break; }
      AutomationElement item = pending.Dequeue();
      ControlType type = item.Current.ControlType;
      if (type == ControlType.Document) continue;
      if (type == ControlType.TabItem) result.Tabs.Add(item);
      if (type == ControlType.Edit) result.Addresses.Add(item);
      for (AutomationElement child = walker.GetFirstChild(item); child != null; child = walker.GetNextSibling(child))
        pending.Enqueue(child);
    }
    return result;
  }

  static bool Matches(Chrome chrome, Uri target) {
    foreach (AutomationElement address in chrome.Addresses) {
      object raw;
      if (!address.TryGetCurrentPattern(ValuePattern.Pattern, out raw)) continue;
      string value = ((ValuePattern)raw).Current.Value;
      Uri uri;
      if (value.IndexOf("://", StringComparison.Ordinal) < 0) value = target.Scheme + "://" + value;
      if (Uri.TryCreate(value, UriKind.Absolute, out uri) &&
          uri.Scheme == target.Scheme && uri.Host == target.Host && uri.Port == target.Port &&
          uri.AbsolutePath == "/app" && uri.UserInfo == "") return true;
    }
    return false;
  }

  static SelectionItemPattern Selection(AutomationElement tab) {
    object pattern;
    return tab.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)
      ? (SelectionItemPattern)pattern : null;
  }

  static bool Activate(IntPtr window) {
    if (IsIconic(window)) ShowWindow(window, 9); // SW_RESTORE
    SetForegroundWindow(window);
    return GetForegroundWindow() == window;
  }

  public static string Focus(string value) {
    Uri target;
    if (!Uri.TryCreate(value, UriKind.Absolute, out target) ||
        (target.Scheme != "http" && target.Scheme != "https") ||
        target.AbsolutePath != "/app" || target.UserInfo != "") return "unavailable";
    List<IntPtr> windows = new List<IntPtr>();
    EnumWindows(delegate(IntPtr window, IntPtr state) {
      if (!IsWindowVisible(window)) return true;
      StringBuilder name = new StringBuilder(128);
      GetClassName(window, name, name.Capacity);
      if (name.ToString() != "Chrome_WidgetWin_1" && name.ToString() != "MozillaWindowClass") return true;
      uint id;
      GetWindowThreadProcessId(window, out id);
      try {
        using (Process process = Process.GetProcessById((int)id))
          if (Browsers.Contains(process.ProcessName)) windows.Add(window);
      } catch { }
      return true;
    }, IntPtr.Zero);
    bool unavailable = false;
    foreach (IntPtr window in windows) {
      SelectionItemPattern previous = null;
      bool selected = false;
      bool found = false;
      try {
        Chrome chrome = ReadChrome(window);
        if (!chrome.Complete || chrome.Addresses.Count == 0) unavailable = true;
        if (Matches(chrome, target)) {
          found = true;
          return Activate(window) ? "focused" : "unavailable";
        }
        foreach (AutomationElement tab in chrome.Tabs) {
          SelectionItemPattern pattern = Selection(tab);
          if (pattern != null && pattern.Current.IsSelected) { previous = pattern; break; }
        }
        foreach (AutomationElement tab in chrome.Tabs) {
          if (tab.Current.Name.IndexOf("轻单", StringComparison.Ordinal) < 0) continue;
          SelectionItemPattern pattern = Selection(tab);
          if (pattern == null) { unavailable = true; continue; }
          pattern.Select();
          selected = true;
          // Selecting a background tab can publish the omnibox a frame later.
          for (int attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) Thread.Sleep(60);
            if (Matches(ReadChrome(window), target)) {
              found = true;
              return Activate(window) ? "focused" : "unavailable";
            }
          }
        }
      } catch { unavailable = true; }
      finally {
        if (!found && selected && previous != null) {
          try { previous.Select(); } catch { }
        }
      }
    }
    return unavailable ? "unavailable" : "absent";
  }
}
'@
[QingdaoWorkspaceFocus]::Focus($env:QINGDAO_WORKSPACE_TARGET)
`;

module.exports = { windowsWorkspaceFocus };
