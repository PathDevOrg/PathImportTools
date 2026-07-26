import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // SW registration is best-effort; offline support simply remains unavailable if it fails.
    });
  });
}
