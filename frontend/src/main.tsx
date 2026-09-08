import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { SITE_MODE } from "./lib/api.ts";
import "./theme.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Offline fallback — hosted (GitHub Pages) copy only. The tool drives a LOCAL operator, so if the
// internet drops the remote page should show a styled page linking to that operator, not a browser
// error. The worker (public/sw.js) caches ONLY offline.html and serves it when a navigation fails;
// it never caches the app shell, /api, or /ws. The operator-served copy on :8010 is already local.
if (SITE_MODE && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* registration is best-effort; the app works without it */
    });
  });
}
