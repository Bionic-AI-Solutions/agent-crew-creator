/** Shared types for the embed widget. */

export interface EmbedConfig {
  allowVoice: boolean;
  allowChat: boolean;
  allowVideo: boolean;
  allowScreenShare: boolean;
  allowAvatar: boolean;
  showTranscription: boolean;
  /**
   * May the agent read the structure of the page this widget is embedded in?
   * Popup mode only -- an iframe embed is a different document. Already the
   * AND of the agent's capability and the token's permission by the time it
   * reaches here.
   */
  allowDomRead: boolean;
  /** May the agent click and type on that page? Implies allowDomRead. */
  allowDomControl: boolean;
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
