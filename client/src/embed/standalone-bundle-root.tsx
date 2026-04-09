/**
 * Entry point for the embed widget bundle (IIFE).
 *
 * For POPUP mode: looks for a <script data-bionic-embed-token="..."> tag,
 * derives the platform origin from the script src, creates a Shadow DOM,
 * and renders the EmbedClient.
 *
 * For IFRAME mode: reads window.__BIONIC_EMBED_CONFIG__ (set by the
 * server-rendered HTML at GET /embed/:token) and renders the IframeView.
 */
import * as React from "react";
import ReactDOM from "react-dom/client";
import { EmbedClient } from "./EmbedClient";
import { IframeView } from "./IframeView";
// @ts-ignore — CSS imported as string for injection into Shadow DOM
import embedStyles from "./embed-styles.css?inline";

// ── IFRAME MODE ─────────────────────────────────────────────────
const iframeConfig = window.__BIONIC_EMBED_CONFIG__;
if (iframeConfig && iframeConfig.mode === "iframe") {
  const container = document.getElementById("embed-root");
  if (container) {
    const root = ReactDOM.createRoot(container);
    // Inject styles into the document head for iframe mode
    const styleTag = document.createElement("style");
    styleTag.textContent = embedStyles;
    document.head.appendChild(styleTag);

    root.render(
      <IframeView
        platformOrigin={iframeConfig.platformOrigin}
        embedToken={iframeConfig.embedToken}
      />,
    );
  }
} else {
  // ── POPUP MODE ──────────────────────────────────────────────
  const scriptTag = document.querySelector<HTMLScriptElement>(
    "script[data-bionic-embed-token]",
  );
  const embedToken = scriptTag?.dataset.bionicEmbedToken;

  if (embedToken && scriptTag?.src) {
    // Derive platform origin from the script tag's src URL
    let platformOrigin: string;
    try {
      platformOrigin = new URL(scriptTag.src).origin;
    } catch {
      console.error("[Bionic Embed] Could not parse script src URL");
      throw new Error("Invalid script src");
    }

    // Create wrapper + Shadow DOM for CSS isolation
    const wrapper = document.createElement("div");
    wrapper.setAttribute("id", "bionic-embed-wrapper");
    document.body.appendChild(wrapper);

    const shadowRoot = wrapper.attachShadow({ mode: "open" });

    // Inject styles into shadow root
    const styleTag = document.createElement("style");
    styleTag.textContent = embedStyles;
    shadowRoot.appendChild(styleTag);

    // React root inside shadow DOM
    const reactRoot = document.createElement("div");
    shadowRoot.appendChild(reactRoot);

    const root = ReactDOM.createRoot(reactRoot);
    root.render(
      <EmbedClient platformOrigin={platformOrigin} embedToken={embedToken} />,
    );
  } else {
    console.error(
      "[Bionic Embed] No data-bionic-embed-token attribute found on script tag.",
    );
  }
}
