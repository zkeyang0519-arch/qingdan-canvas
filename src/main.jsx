import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import OpeningGate from "./opening/OpeningGate.jsx";
import { desktopPreviewSelected } from "./desktop/online-launch.js";
import "./canvas/canvas.css";
import "./canvas/todoTools.css";
import "./app.css";
import "./ops/operations.css";
import "./ui/luma.css";

// Remember download-page selection before login/room navigation rewrites the URL.
desktopPreviewSelected();

createRoot(document.getElementById("root")).render(
  <OpeningGate>
    <App />
  </OpeningGate>,
);
