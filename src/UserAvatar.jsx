import React from "react";

export default function UserAvatar({
  userId,
  name,
  label = name,
  className = "",
}) {
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
      {userId ? Array.from(name || "?")[0] : "?"}
    </span>
  );
}
