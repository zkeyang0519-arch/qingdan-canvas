$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# All request fields, including the secret, arrive over the anonymous stdin pipe.
# No enumeration API is imported and every operation checks the exact namespace.
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.target -cnotmatch '^QingdanRunner/v1/[a-f0-9]{64}/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') { throw 'Invalid target' }
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class QingdanCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWriteW(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredReadW(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDeleteW(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);
}
"@
  switch ($request.operation) {
    'write' {
      if ([string]::IsNullOrEmpty($request.secret)) { throw 'Missing secret' }
      $bytes = [Text.Encoding]::Unicode.GetBytes($request.secret)
      if ($bytes.Length -gt 2560) { throw 'Credential too long' }
      $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
      try {
        [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
        $credential = New-Object QingdanCredential+CREDENTIAL
        $credential.Type = 1 # CRED_TYPE_GENERIC
        $credential.TargetName = $request.target
        $credential.CredentialBlobSize = $bytes.Length
        $credential.CredentialBlob = $blob
        $credential.Persist = 2 # CRED_PERSIST_LOCAL_MACHINE, current user only
        $credential.UserName = 'QingdanRunner'
        if (-not [QingdanCredential]::CredWriteW([ref]$credential,0)) { throw 'CredWrite failed' }
      } finally {
        for ($i=0; $i -lt $bytes.Length; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($blob,$i,0) }
        [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
        [Array]::Clear($bytes,0,$bytes.Length)
      }
      [Console]::Out.Write('{"ok":true}')
    }
    'read' {
      $pointer = [IntPtr]::Zero
      if (-not [QingdanCredential]::CredReadW($request.target,1,0,[ref]$pointer)) {
        if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { [Console]::Out.Write('{"secret":null}'); break }
        throw 'CredRead failed'
      }
      try {
        $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer,[type][QingdanCredential+CREDENTIAL])
        $secret = [Runtime.InteropServices.Marshal]::PtrToStringUni($credential.CredentialBlob,($credential.CredentialBlobSize / 2))
        [Console]::Out.Write((@{secret=$secret} | ConvertTo-Json -Compress))
      } finally { [QingdanCredential]::CredFree($pointer) }
    }
    'delete' {
      if (-not [QingdanCredential]::CredDeleteW($request.target,1,0)) {
        if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'CredDelete failed' }
      }
      [Console]::Out.Write('{"ok":true}')
    }
    default { throw 'Invalid operation' }
  }
} catch {
  # Never print request data, native buffers or exceptions which may contain it.
  [Console]::Error.Write('Runner Credential Manager operation failed.')
  exit 1
}
