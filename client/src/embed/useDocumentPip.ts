/**
 * Document Picture-in-Picture for the embed widget.
 *
 * A backgrounded tab is not rendered at all, so no amount of z-index keeps the
 * widget visible once a visitor switches tabs — which is precisely when they
 * need it, mid screen-share. `documentPictureInPicture.requestWindow()` opens a
 * real always-on-top OS window that can hold arbitrary DOM, and it runs in the
 * SAME JS context, so the LiveKit Room, the microphone track and the
 * screen-share track carry on untouched. No reconnect, no second session.
 *
 * Chromium-only at the time of writing (absent in Firefox and Safari), so
 * everything here is gated on `supported` and the button stays hidden
 * elsewhere. Also requires a secure context and a user gesture.
 */
import { useCallback, useEffect, useState } from "react";

interface DocumentPipApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

function pipApi(): DocumentPipApi | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { documentPictureInPicture?: DocumentPipApi })
    .documentPictureInPicture ?? null;
}

/**
 * `styleText` is the widget's own stylesheet. The PiP document starts empty and
 * inherits nothing — the widget's CSS lives inside the host page's shadow root
 * and does not travel — so without copying it across the popped-out widget
 * renders as unstyled HTML.
 */
export function useDocumentPip(styleText: string) {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const supported = pipApi() !== null;

  const open = useCallback(async () => {
    const api = pipApi();
    if (!api) return;
    try {
      // Matches the in-page panel so the widget does not reflow when it moves.
      const win = await api.requestWindow({ width: 360, height: 520 });

      const style = win.document.createElement("style");
      style.textContent = styleText;
      win.document.head.appendChild(style);

      win.document.title = "Agent";
      win.document.body.className = "bionic-pip-body";

      // Closing via the window's own chrome must also reset the host page.
      win.addEventListener("pagehide", () => setPipWindow(null), { once: true });
      setPipWindow(win);
    } catch {
      // requestWindow rejects if the gesture expired or one is already open.
      setPipWindow(null);
    }
  }, [styleText]);

  const close = useCallback(() => {
    // The pagehide listener clears the state; closing here keeps one code path.
    pipWindow?.close();
  }, [pipWindow]);

  // A PiP window outlives the page that opened it, so it must be closed when
  // the widget unmounts or the visitor navigates away.
  useEffect(() => {
    if (!pipWindow) return;
    const closeIt = () => pipWindow.close();
    window.addEventListener("pagehide", closeIt);
    return () => {
      window.removeEventListener("pagehide", closeIt);
      pipWindow.close();
    };
  }, [pipWindow]);

  return { supported, pipWindow, open, close };
}
