import { useState, useCallback } from "react";
import { Track } from "livekit-client";
import {
  TrackToggle,
  useLocalParticipant,
  useRemoteParticipants,
} from "@livekit/components-react";
import type { EmbedConfig } from "./types";

interface ActionBarProps {
  config: EmbedConfig;
  chatOpen: boolean;
  onChatToggle: () => void;
  onDisconnect: () => void;
}

export function ActionBar({ config, chatOpen, onChatToggle, onDisconnect }: ActionBarProps) {
  const participants = useRemoteParticipants();
  const { isCameraEnabled, isScreenShareEnabled } = useLocalParticipant();
  const isAgentAvailable = participants.some((p) => p.isAgent);

  return (
    <div className="bionic-action-bar">
      <div className="bionic-action-bar-left">
        {/* Microphone */}
        {config.allowVoice && (
          <TrackToggle
            source={Track.Source.Microphone}
            className="bionic-action-btn"
          />
        )}

        {/* Camera */}
        {config.allowVideo && (
          <TrackToggle
            source={Track.Source.Camera}
            className="bionic-action-btn"
          />
        )}
      </div>

      <div className="bionic-action-bar-right">
        {/* Screen Share */}
        {config.allowScreenShare && (
          <TrackToggle
            source={Track.Source.ScreenShare}
            className="bionic-action-btn"
          />
        )}

        {/* Chat toggle */}
        {config.allowChat && (
          <button
            className={`bionic-action-btn ${chatOpen ? "bionic-action-btn-active" : ""}`}
            onClick={onChatToggle}
            disabled={!isAgentAvailable}
            title="Toggle chat"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        )}

        {/* Disconnect */}
        <button className="bionic-action-btn bionic-action-btn-disconnect" onClick={onDisconnect} title="Disconnect">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
