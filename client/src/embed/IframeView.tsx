import { useEffect, useMemo, useState } from "react";
import { Room, RoomEvent } from "livekit-client";
import { RoomAudioRenderer, RoomContext, StartAudio } from "@livekit/components-react";
import useEmbedConnection from "./useEmbedConnection";
import { PopupView } from "./PopupView";
import type { EmbedErrorDetails } from "./types";

interface IframeViewProps {
  platformOrigin: string;
  embedToken: string;
}

/**
 * Full-viewport embed for iframe mode.
 * Auto-connects on mount (no trigger button needed).
 */
export function IframeView({ platformOrigin, embedToken }: IframeViewProps) {
  const room = useMemo(() => new Room(), []);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<EmbedErrorDetails | null>(null);
  const { connectionDetails, existingOrRefreshConnectionDetails } = useEmbedConnection(
    platformOrigin,
    embedToken,
  );

  // Auto-connect on mount
  useEffect(() => {
    if (!connectionDetails || connected) return;

    const connect = async () => {
      try {
        const details = await existingOrRefreshConnectionDetails();
        await room.connect(details.serverUrl, details.participantToken);
        // Enable microphone if voice is allowed
        if (details.config.allowVoice) {
          await room.localParticipant.setMicrophoneEnabled(true);
        }
        setConnected(true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError({ title: "Connection failed", description: msg });
      }
    };

    connect();
  }, [connectionDetails, connected, room, existingOrRefreshConnectionDetails]);

  // Handle disconnect
  useEffect(() => {
    const onDisconnected = () => {
      setConnected(false);
      setError({ title: "Disconnected", description: "The session has ended." });
    };
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => { room.off(RoomEvent.Disconnected, onDisconnected); };
  }, [room]);

  const handleDisconnect = () => {
    room.disconnect();
  };

  if (error) {
    return (
      <div className="bionic-iframe-error">
        <div className="bionic-error-title">{error.title}</div>
        <div className="bionic-error-desc">{error.description}</div>
      </div>
    );
  }

  if (!connectionDetails) {
    return (
      <div className="bionic-iframe-loading">
        <div className="bionic-loading-spinner" />
        <div>Connecting...</div>
      </div>
    );
  }

  return (
    <div className={`bionic-iframe-root bionic-theme-${connectionDetails.config.theme}`}>
      <RoomContext.Provider value={room}>
        <RoomAudioRenderer />
        <StartAudio label="Start Audio" />
        <PopupView
          config={connectionDetails.config}
          sessionStarted={connected}
          onError={setError}
          onDisconnect={handleDisconnect}
        />
      </RoomContext.Provider>
    </div>
  );
}
