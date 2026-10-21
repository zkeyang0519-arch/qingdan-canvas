import React, { memo } from "react";
import { imageSvg } from "./images.js";

export default memo(function ImageContent({
  object,
  url,
  pending = [],
  onDoubleClick,
}) {
  return (
    <div
      className="image-content"
      role="img"
      aria-label={object.alt || "图片"}
      onDoubleClick={onDoubleClick}
      dangerouslySetInnerHTML={{ __html: imageSvg(object, url, pending) }}
    />
  );
});
