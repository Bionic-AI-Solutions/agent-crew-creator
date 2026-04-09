import { useEffect, useMemo, useState } from "react";
import { Track } from "livekit-client";
import {
  type AgentState,
  type TrackReference,
  VideoTrack,
  useLocalParticipant,
  useTracks,
  useVoiceAssistant,
  useRoomContext,
} from "@livekit/components-react";
import { ActionBar } from "./ActionBar";
import { AudioVisualizer } from "./AudioVisualizer";
import { AvatarView } from "./AvatarView";
import { TranscriptPanel } from "./TranscriptPanel";
import type { EmbedConfig, EmbedErrorDetails } from "./types";

function useLocalTrackRef(source: Track.Source) {
  const { localParticipant } = useLocalParticipant();
  const publication = localParticipant.getTrackPublication(source);
  return useMemo<TrackReference | undefined>(
    () => (publication ? { source, participant: localParticipant, publication } : undefined),
    [source, publication, localParticipant],
  );
}

function isAgentAvailable(state: AgentState) {
  return state === "listening" || state === "thinking" || state === "speaking";
}

interface PopupViewProps {
  config: EmbedConfig;
  sessionStarted: boolean;
  onError: (err: EmbedErrorDetails) => void;
  onDisconnect: () => void;
}

export function PopupView({ config, sessionStarted, onError, onDisconnect }: PopupViewProps) {
  const room = useRoomContext();
  const {
    state: agentState,
    audioTrack: agentAudioTrack,
    videoTrack: agentVideoTrack,
  } = useVoiceAssistant();
  const { isCameraEnabled, isScreenShareEnabled } = useLocalParticipant();
  const [screenShareTrack] = useTracks([Track.Source.ScreenShare]);
  const cameraTrack = useLocalTrackRef(Track.Source.Camera);
  const [chatOpen, setChatOpen] = useState(false);

  const showAvatar = config.allowAvatar && config.agentHasAvatar && !!agentVideoTrack;
  const showCameraTile = (isCameraEnabled && !!cameraTrack) || (isScreenShareEnabled && !!screenShareTrack);

  // Agent connection timeout
  useEffect(() => {
    if (!sessionStarted) return;
    const timeout = setTimeout(() => {
      if (!isAgentAvailable(agentState)) {
        onError({
          title: "Session ended",
          description: agentState === "connecting"
            ? "Agent did not join the room."
            : "Agent connected but did not finish initializing.",
        });
      }
    }, 10_000);
    return () => clearTimeout(timeout);
  }, [agentState, sessionStarted, onError]);

  return (
    <div className="bionic-popup-view">
      <div className="bionic-popup-content">
        {/* Transcript panel (slides up when chat is open) */}
        {config.allowChat && (
          <div className={`bionic-transcript-container ${chatOpen ? "bionic-transcript-open" : ""}`}>
            <TranscriptPanel config={config} />
          </div>
        )}

        {/* Audio Visualizer (shown when no avatar) */}
        {!showAvatar && (
          <div className={`bionic-viz-container ${chatOpen ? "bionic-viz-small" : ""}`}>
            <AudioVisualizer agentState={agentState} audioTrack={agentAudioTrack} />
          </div>
        )}

        {/* Avatar */}
        {showAvatar && (
          <AvatarView
            videoTrack={agentVideoTrack}
            chatOpen={chatOpen}
            showCameraTile={showCameraTile}
          />
        )}

        {/* Camera/Screen Share tile */}
        {showCameraTile && chatOpen && (
          <div className="bionic-camera-tile" style={{ right: "12px", top: "12px" }}>
            <VideoTrack
              trackRef={cameraTrack || screenShareTrack}
              width={(cameraTrack || screenShareTrack)?.publication.dimensions?.width ?? 0}
              height={(cameraTrack || screenShareTrack)?.publication.dimensions?.height ?? 0}
              className="bionic-tile-video"
            />
          </div>
        )}
      </div>

      {/* Action bar */}
      <div className={`bionic-action-bar-container ${sessionStarted ? "bionic-action-bar-visible" : ""}`}>
        <ActionBar
          config={config}
          chatOpen={chatOpen}
          onChatToggle={() => setChatOpen(!chatOpen)}
          onDisconnect={onDisconnect}
        />
      </div>
    </div>
  );
}
