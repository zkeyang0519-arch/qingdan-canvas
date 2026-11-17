import React, { useId, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { islandReleases } from "./island-releases.js";

export default function IslandReleaseHistory() {
  const [selected, setSelected] = useState(islandReleases[0]);
  const menu = useRef(null);
  const id = useId();
  return (
    <section className="island-release-history" aria-labelledby={id}>
      <div className="island-settings-row">
        <strong id={id}>历史版本</strong>
        <small>外观预览</small>
      </div>
      <details ref={menu} className="island-release-menu">
        <summary aria-label="选择历史版本">
          <img src={selected.image} alt={`轻岛 v${selected.version} 缩略图`} />
          <span>
            {selected.title}
            <small>v{selected.version}</small>
          </span>
          <ChevronDown size={15} />
        </summary>
        <div className="island-release-options" aria-label="历史版本选项">
          {islandReleases.map((release) => (
            <button
              key={release.version}
              type="button"
              aria-label={`预览轻岛 v${release.version}`}
              aria-pressed={selected.version === release.version}
              onClick={() => {
                setSelected(release);
                menu.current.open = false;
                menu.current
                  .querySelector("summary")
                  .focus({ preventScroll: true });
              }}
            >
              <img
                src={release.image}
                alt={`轻岛 v${release.version} 外观`}
                loading="lazy"
              />
              <span>
                <span>
                  {release.title}
                  <small>v{release.version}</small>
                </span>
                {selected.version === release.version && <Check size={13} />}
              </span>
            </button>
          ))}
        </div>
      </details>
      <figure className="island-release-preview">
        <img src={selected.image} alt={`轻岛 v${selected.version} 外观预览`} />
        <figcaption>{selected.description}</figcaption>
      </figure>
    </section>
  );
}
