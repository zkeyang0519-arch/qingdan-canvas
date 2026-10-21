import React from "react";
import CollectionWrap from "./CollectionWrap.jsx";
import CollectionFlight, { Snapshot } from "./CollectionFlight.jsx";

export default function ArrangedCollectionOverlay({
  session,
  viewport,
  objects,
  assetUrls,
  onDone,
}) {
  if (!session) return null;
  const r = viewport.current?.getBoundingClientRect();
  return (
    <div
      className="arranged-collection-overlay"
      aria-hidden="true"
      inert
      style={{ left: r?.left || 0, top: r?.top || 0 }}
    >
      {session.phase === "dragging" && session.target && (
        <CollectionWrap
          target={session.target}
          rects={session.roots.map(({ screen, scale }) => ({
            x: screen.x + session.delta.x,
            y: screen.y + session.delta.y,
            width: screen.width * scale,
            height: screen.height * scale,
          }))}
        />
      )}
      {session.roots.map(({ object, screen, scale }) =>
        session.phase === "collecting" ? (
          <CollectionFlight
            key={`${session.token}-${object.id}`}
            objects={objects}
            assetUrls={assetUrls}
            onDone={onDone}
            flight={{
              ...session,
              startScale: session.startScale ?? scale,
              token: session.token,
              object: {
                ...object,
                x: screen.x + session.delta.x,
                y: screen.y + session.delta.y,
              },
              renderObject: object,
            }}
          />
        ) : (
          <div
            key={object.id}
            className={`arranged-floating object-${object.type} ${session.phase === "returning" ? "is-returning" : ""}`}
            style={{
              left: screen.x + session.delta.x,
              top: screen.y + session.delta.y,
              width: screen.width,
              height: screen.height,
              "--drag-scale": scale,
              "--return-x": `${-session.delta.x}px`,
              "--return-y": `${-session.delta.y}px`,
            }}
          >
            <Snapshot
              object={object}
              snapshot={session.snapshot}
              visibleIds={session.visibleIds}
              objects={objects}
              assetUrls={assetUrls}
            />
          </div>
        ),
      )}
      {session.phase === "dragging" && (
        <span
          className={`collection-anchor ${session.target ? "is-receiving" : ""}`}
          style={{
            left: session.anchor.x + session.delta.x,
            top: session.anchor.y + session.delta.y,
            width: 8,
            height: 8,
            borderWidth: 1.5,
          }}
        />
      )}
    </div>
  );
}
