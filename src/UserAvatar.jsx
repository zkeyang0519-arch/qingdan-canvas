import React, { useState } from "react";

export default function UserAvatar({
  userId,
  name,
  avatarVersion,
  viewerId = userId,
  label = name,
  className = "",
}) {
  const [failedSrc, setFailedSrc] = useState(null);
  const src =
    userId && avatarVersion && viewerId
      ? `/api/avatars/${encodeURIComponent(userId)}?${new URLSearchParams({ v: avatarVersion, account: viewerId })}`
      : null;
  let hash = 0;
  for (const char of userId || "")
    hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return (
    <span
      className={`avatar avatar-${hash % 4} ${className}`}
      role="img"
      aria-label={label}
      title={label}
    >
      {src && src !== failedSrc ? (
        <img
          src={src}
          alt=""
          draggable={false}
          onError={() => setFailedSrc(src)}
        />
      ) : userId ? (
        Array.from(name || "?")[0]
      ) : (
        "?"
      )}
    </span>
  );
}
