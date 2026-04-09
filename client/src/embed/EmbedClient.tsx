import { useEffect, useMemo, useRef, useState } from "react";
import { Room, RoomEvent } from "livekit-client";
import { RoomAudioRenderer, RoomContext, StartAudio } from "@livekit/components-react";
import useEmbedConnection from "./useEmbedConnection";
import { PopupView } from "./PopupView";
import type { EmbedErrorDetails } from "./types";

interface EmbedClientProps {
  platformOrigin: string;
  embedToken: string;
}

/**
 * Popup-mode embed client. Renders a floating trigger button
 * and an expandable panel with the agent session.
 */
export function EmbedClient({ platformOrigin, embedToken }: EmbedClientProps) {
  const room = useMemo(() => new Room(), []);
  const [popupOpen, setPopupOpen] = useState(false);
  const [error, setError] = useState<EmbedErrorDetails | null>(null);
  const isAnimating = useRef(false);

  const {
    connectionDetails,
    refreshConnectionDetails,
    existingOrRefreshConnectionDetails,
  } = useEmbedConnection(platformOrigin, embedToken);

  const handleToggle = () => {
    if (isAnimating.current) return;
    setError(null);
    setPopupOpen((open) => !open);
  };

  // Room event listeners
  useEffect(() => {
    const onDisconnected = () => {
      setPopupOpen(false);
      refreshConnectionDetails().catch(() => {});
    };
    const onMediaError = (err: Error) => {
      setError({
        title: "Media device error",
        description: `${err.name}: ${err.message}`,
      });
    };
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.MediaDevicesError, onMediaError);
    return () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.MediaDevicesError, onMediaError);
    };
  }, [room, refreshConnectionDetails]);

  // Connect when popup opens
  useEffect(() => {
    if (!popupOpen || !connectionDetails || room.state !== "disconnected") return;

    const connect = async () => {
      try {
        const details = await existingOrRefreshConnectionDetails();
        await Promise.all([
          details.config.allowVoice
            ? room.localParticipant.setMicrophoneEnabled(true)
            : Promise.resolve(),
          room.connect(details.serverUrl, details.participantToken),
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError({ title: "Connection failed", description: msg });
      }
    };

    connect();
  }, [popupOpen, connectionDetails, room, existingOrRefreshConnectionDetails]);

  const handleDisconnect = () => {
    room.disconnect();
  };

  // CSS transition callbacks
  const handleTransitionStart = () => { isAnimating.current = true; };
  const handleTransitionEnd = () => {
    isAnimating.current = false;
    if (!popupOpen && room.state !== "disconnected") {
      room.disconnect();
    }
  };

  const theme = connectionDetails?.config.theme || "light";

  return (
    <RoomContext.Provider value={room}>
      <RoomAudioRenderer />
      <StartAudio label="Start Audio" />

      {/* Trigger button */}
      <button className="bionic-trigger" onClick={handleToggle} title="Chat with agent">
        {!popupOpen ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        )}
      </button>

      {/* Popup panel */}
      <div
        className={`bionic-popup bionic-theme-${theme} ${popupOpen ? "bionic-popup-open" : "bionic-popup-closed"}`}
        onTransitionEnd={handleTransitionEnd}
      >
        <div className="bionic-popup-inner">
          {error ? (
            <div className="bionic-popup-error">
              <div className="bionic-error-title">{error.title}</div>
              <div className="bionic-error-desc">{error.description}</div>
              <button className="bionic-error-retry" onClick={handleToggle}>Close</button>
            </div>
          ) : connectionDetails ? (
            <PopupView
              config={connectionDetails.config}
              sessionStarted={popupOpen}
              onError={setError}
              onDisconnect={handleDisconnect}
            />
          ) : (
            <div className="bionic-popup-loading">
              <div className="bionic-loading-spinner" />
              <div>Connecting...</div>
            </div>
          )}
        </div>
      </div>
    </RoomContext.Provider>
  );
}
