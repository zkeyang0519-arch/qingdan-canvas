import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/permission-preference-"));
await build({ entryPoints: [resolve("src/agent/PermissionControls.jsx")], bundle: true, format: "esm", platform: "node", packages: "external", outfile: resolve(dir, "ui.mjs") });
const { usePermissionPreference } = await import(pathToFileURL(resolve(dir, "ui.mjs")));
rmSync(dir, { recursive: true, force: true });
function Preference({ label, userId = "alice" }) {
  const [value, setValue] = usePermissionPreference(userId, { bindingId: "binding", revision: 1 });
  return React.createElement("button", { "aria-label": label, onClick: () => setValue("read_only") }, value);
}
test("permission changes synchronize same-page consumers without leaking to another account", async () => {
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(React.Fragment, null,
      React.createElement(Preference, { label: "checklist" }),
      React.createElement(Preference, { label: "composer" }),
      React.createElement(Preference, { label: "other-account", userId: "bob" }),
    )));
    await act(async () => document.querySelector('[aria-label="checklist"]').click());
    assert.equal(document.querySelector('[aria-label="composer"]').textContent, "read_only");
    assert.equal(document.querySelector('[aria-label="other-account"]').textContent, "full_access");
  } finally { await act(async () => root.unmount()); }
});
