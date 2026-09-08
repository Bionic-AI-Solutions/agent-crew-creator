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
  /** Omitted where popping out is unavailable (iframe mode, or a browser
   *  without Document Picture-in-Picture) — the control then does not render. */
  pip?: { active: boolean; onToggle: () => void };
}

export function ActionBar({ config, chatOpen, onChatToggle, onDisconnect, pip }: ActionBarProps) {
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
        {/* Pop out into an always-on-top window. Sits beside screen share
            because that is when it matters: a backgrounded tab stops being
            rendered, so this is the only way to keep the session visible
            while the visitor browses somewhere else. */}
        {pip && (
          <button
            className={`bionic-action-btn ${pip.active ? "bionic-action-btn-active" : ""}`}
            onClick={pip.onToggle}
            title={pip.active ? "Put the agent back on the page" : "Keep the agent on top while you browse"}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {pip.active ? (
                <>
                  <path d="M21 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" />
                  <rect x="11" y="12" width="10" height="8" rx="1" />
                </>
              ) : (
                <>
                  <path d="M3 15V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4" />
                  <rect x="3" y="13" width="10" height="8" rx="1" />
                </>
              )}
            </svg>
          </button>
        )}

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
