import { VideoTrack, type TrackReference } from "@livekit/components-react";

interface AvatarViewProps {
  videoTrack: TrackReference | undefined;
  chatOpen: boolean;
  showCameraTile: boolean;
}

/**
 * Renders the agent's avatar video in two modes:
 * - Chat closed: full-background with cover fit
 * - Chat open: small 70px tile in top-left
 */
export function AvatarView({ videoTrack, chatOpen, showCameraTile }: AvatarViewProps) {
  if (!videoTrack) return null;

  if (!chatOpen) {
    // Full background avatar
    return (
      <div className="bionic-avatar-bg">
        <VideoTrack
          trackRef={videoTrack}
          width={videoTrack.publication.dimensions?.width ?? 0}
          height={videoTrack.publication.dimensions?.height ?? 0}
          className="bionic-avatar-bg-video"
        />
      </div>
    );
  }

  // Small tile when chat is open
  return (
    <div
      className="bionic-avatar-tile"
      style={{ left: showCameraTile ? "calc(50% - 44px)" : "50%", transform: "translateX(-50%)" }}
    >
      <VideoTrack
        trackRef={videoTrack}
        width={videoTrack.publication.dimensions?.width ?? 0}
        height={videoTrack.publication.dimensions?.height ?? 0}
        className="bionic-tile-video"
      />
    </div>
  );
}
