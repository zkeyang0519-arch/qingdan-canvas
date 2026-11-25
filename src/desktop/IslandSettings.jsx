import React from "react";
import IslandAppearanceSettings from "./IslandAppearanceSettings.jsx";
import DesktopUpdateCheck from "./DesktopUpdateCheck.jsx";
import LocalServiceSettings from "./LocalServiceSettings.jsx";
import IslandReleaseHistory from "./IslandReleaseHistory.jsx";
import "./island-settings.css";

export default function IslandSettings({
  appearance,
  bridge,
  toolbar,
  sizeControls,
}) {
  return (
    <>
      <IslandAppearanceSettings
        value={appearance.value}
        onChange={appearance.update}
        error={appearance.error}
      />
      {sizeControls}
      <LocalServiceSettings bridge={bridge} />
      <DesktopUpdateCheck bridge={bridge} />
      <IslandReleaseHistory />
      {toolbar && <div className="island-settings-actions">{toolbar}</div>}
    </>
  );
}
