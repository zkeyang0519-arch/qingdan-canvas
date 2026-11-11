import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import OpeningGate from "./opening/OpeningGate.jsx";
import "./canvas/canvas.css";
import "./canvas/todoTools.css";
import "./app.css";
import "./ops/operations.css";

createRoot(document.getElementById("root")).render(
  <OpeningGate>
    <App />
  </OpeningGate>,
);
