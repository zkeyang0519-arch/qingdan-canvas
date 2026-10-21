import React, { useEffect } from "react";
import { Archive, ChevronDown, ChevronRight } from "lucide-react";
import CollectionWrap from "./CollectionWrap.jsx";
import Note from "./Note.jsx";
import ImageContent from "./ImageContent.jsx";
import { displayRect } from "./layout.js";

export function Snapshot({ object, snapshot, visibleIds, objects, assetUrls }) {
  if (object.type === "note") return <Note object={object} objects={objects} />;
  if (object.type === "image")
    return <ImageContent object={object} url={assetUrls.get(object.assetId)} />;
  const members = snapshot.filter((o) => o.parentId === object.id);
  if (object.type === "collection")
    return (
      <div className="collection-icon">
        <Archive size={46} strokeWidth={1.35} />
        {members.length > 0 && (
          <span className="collection-count">{members.length}</span>
        )}
      </div>
    );
  return (
    <div className={`group-frame ${object.collapsed ? "collapsed" : ""}`}>
      <div className="frame-heading">
        {object.collapsed ? (
          <ChevronRight size={16} />
        ) : (
          <ChevronDown size={16} />
        )}
        <span>{object.title}</span>
        <small>{members.length}</small>
      </div>
      {!object.collapsed &&
        members
          .filter((o) => visibleIds.has(o.id))
          .map((child) => (
            <div
              key={child.id}
              className={`collection-flight-child object-${child.type}`}
              style={{
                left: child.x - object.x,
                top: child.y - object.y,
                width: child.width,
                height: displayRect(child).height,
              }}
            >
              <Snapshot
                object={child}
                snapshot={snapshot}
                visibleIds={visibleIds}
                objects={objects}
                assetUrls={assetUrls}
              />
            </div>
          ))}
    </div>
  );
}

// Ownership is already saved; this copy is only the short visual transition.
export default function CollectionFlight({
  flight,
  assetUrls,
  objects,
  onDone,
}) {
  const { token, object, target, startScale, snapshot, visibleIds } = flight;
  useEffect(() => {
    // Also clean up when the browser skips animation events or reduces motion.
    const timer = setTimeout(() => onDone(token), 400);
    return () => clearTimeout(timer);
  }, [token, onDone]);
  return (
    <>
      <CollectionWrap
        collecting
        target={target}
        scale={flight.wrapScale || 1}
        rects={[
          {
            ...object,
            width: object.width * startScale,
            height: (object.layoutHeight || object.height) * startScale,
          },
        ]}
      />
      <div
        className={`collection-flight object-${object.type}`}
        aria-hidden="true"
        inert
        style={{
          left: object.x,
          top: object.y,
          width: object.width,
          height: object.layoutHeight || object.height,
          "--collect-start-scale": startScale,
          "--collect-x": `${target.x + target.width / 2 - object.x - object.width * 0.03}px`,
          "--collect-y": `${target.y + target.height / 2 - object.y - (object.layoutHeight || object.height) * 0.03}px`,
        }}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) onDone(token);
        }}
      >
        <Snapshot
          object={flight.renderObject || object}
          snapshot={snapshot}
          visibleIds={visibleIds}
          objects={objects}
          assetUrls={assetUrls}
        />
      </div>
    </>
  );
}
