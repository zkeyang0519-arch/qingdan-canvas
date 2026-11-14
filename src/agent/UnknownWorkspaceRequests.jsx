import React from "react";

export default function UnknownWorkspaceRequests({ requests }) {
  if (!requests.unknownRecords.length) return null;
  return (
    <details className="agent-note" aria-label="未识别的恢复记录">
      <summary>
        有 {requests.unknownRecords.length}{" "}
        项恢复记录无法确认归属，已保留，仅供只读核对。
      </summary>
      <pre>{JSON.stringify(requests.unknownRecords, null, 2)}</pre>
    </details>
  );
}
