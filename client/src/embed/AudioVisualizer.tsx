import type { AgentState, TrackReference } from "@livekit/components-react";
import { BarVisualizer } from "@livekit/components-react";

interface AudioVisualizerProps {
  agentState: AgentState;
  audioTrack?: TrackReference;
}

export function AudioVisualizer({ agentState, audioTrack }: AudioVisualizerProps) {
  return (
    <BarVisualizer
      barCount={5}
      state={agentState}
      trackRef={audioTrack}
      options={{ minHeight: 5 }}
      className="bionic-audio-viz"
    >
      <span className="bionic-audio-viz-bar" />
    </BarVisualizer>
  );
}
