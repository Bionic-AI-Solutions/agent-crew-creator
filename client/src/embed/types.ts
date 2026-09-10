/** Shared types for the embed widget. */

export interface EmbedConfig {
  allowVoice: boolean;
  allowChat: boolean;
  allowVideo: boolean;
  allowScreenShare: boolean;
  allowAvatar: boolean;
  showTranscription: boolean;
  theme: string;
  agentHasAvatar: boolean;
  /** Display name for the agent's speech; its participant has no name set. */
  agentName: string;
}

export interface ConnectionDetails {
  serverUrl: string;
  roomName: string;
  participantToken: string;
  participantName: string;
  config: EmbedConfig;
}

export interface EmbedErrorDetails {
  title: string;
  description: string;
}

/** Set by the iframe HTML page at GET /embed/:token */
export interface IframeBootConfig {
  embedToken: string;
  platformOrigin: string;
  mode: "iframe";
}

declare global {
  interface Window {
    __BIONIC_EMBED_CONFIG__?: IframeBootConfig;
  }
}
