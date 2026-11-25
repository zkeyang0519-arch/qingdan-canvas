import React, { useState } from "react";
import WorkspaceDrawer from "./WorkspaceDrawer.jsx";
import { filmUrl } from "./film-model.js";

export default function ChatImages({ media, scope }) {
  const [selected, select] = useState(null);
  if (!media?.length) return null;
  const url = (item) =>
    item.filmId
      ? filmUrl(
          scope,
          "/" +
            encodeURIComponent(item.filmId) +
            "/media/" +
            encodeURIComponent(item.id),
        )
      : "/api/agent/chat/media/" + encodeURIComponent(item.id);
  const current = media.findIndex((item) => url(item) === selected);
  const image = media[current];
  return (
    <>
      <div className="agent-message-media" role="group" aria-label="参考图">
        {media.map((item) => (
          <figure key={url(item)}>
            <button
              type="button"
              className="agent-image-thumbnail"
              onClick={() => select(url(item))}
              aria-label={"放大" + item.label}
            >
              <img
                src={url(item)}
                alt={item.title || item.label}
                loading="lazy"
              />
            </button>
            <figcaption>{item.label}</figcaption>
          </figure>
        ))}
      </div>
      {image && (
        <WorkspaceDrawer
          title={image.label}
          label="参考图预览"
          closeLabel="关闭图片预览"
          size="wide"
          onClose={() => select(null)}
        >
          <div className="agent-image-preview">
            <img src={selected} alt={image.title || image.label} />
            <div>
              {media.length > 1 && (
                <>
                  <button
                    type="button"
                    disabled={current === 0}
                    onClick={() => select(url(media[current - 1]))}
                  >
                    上一张
                  </button>
                  <span aria-live="polite">
                    {current + 1} / {media.length}
                  </span>
                  <button
                    type="button"
                    disabled={current === media.length - 1}
                    onClick={() => select(url(media[current + 1]))}
                  >
                    下一张
                  </button>
                </>
              )}
              <a href={selected} target="_blank" rel="noreferrer">
                打开原图
              </a>
            </div>
          </div>
        </WorkspaceDrawer>
      )}
    </>
  );
}
