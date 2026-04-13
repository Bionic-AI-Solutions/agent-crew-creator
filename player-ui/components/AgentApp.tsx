"use client";

import { useSession, signIn, signOut } from "next-auth/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useChat,
  useConnectionState,
  useVoiceAssistant,
  useLocalParticipant,
  BarVisualizer,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { ConnectionState } from "livekit-client";

interface AgentInfo {
  id: number;
  name: string;
  displayName: string;
  deployed: boolean;
  dispatchName: string;
  capabilities?: {
    vision?: boolean;
    avatar?: boolean;
    backgroundAudio?: boolean;
  };
}

interface ConnectionBundle {
  token: string;
  livekitUrl: string;
  roomName: string;
  identity: string;
  displayName: string;
}

export function AgentApp() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <LoadingScreen message="Authenticating..." />;
  }

  if (!session) {
    return <SignInScreen />;
  }

  return <AuthenticatedApp session={session} />;
}

function LoadingScreen({ message }: { message: string }) {
  return (
    <div style={styles.center}>
      <div style={styles.spinner} />
      <p style={{ color: "var(--text-muted)", marginTop: 16 }}>{message}</p>
    </div>
  );
}

function SignInScreen() {
  return (
    <div style={styles.center}>
      <div style={styles.card}>
        <h1 style={{ fontSize: 24, marginBottom: 8 }}>Agent Player</h1>
        <p style={{ color: "var(--text-muted)", marginBottom: 24, fontSize: 14 }}>
          Sign in to connect with your AI agents
        </p>
        <button onClick={() => signIn("keycloak")} style={styles.primaryBtn}>
          Sign in with Keycloak
        </button>
      </div>
    </div>
  );
}

function AuthenticatedApp({ session }: { session: any }) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [connection, setConnection] = useState<ConnectionBundle | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // Poll for agents
  useEffect(() => {
    const fetchAgents = async () => {
      try {
        const res = await fetch("/api/agents");
        if (res.ok) {
          const data = await res.json();
          setAgents(data.agents || []);
        }
      } catch {
        // Will retry on next poll
      }
    };
    fetchAgents();
    pollRef.current = setInterval(fetchAgents, 15000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Auto-select first agent if only one
  useEffect(() => {
    if (agents.length === 1 && !selectedAgent) {
      setSelectedAgent(agents[0]);
    }
  }, [agents, selectedAgent]);

  const connect = useCallback(async () => {
    if (!selectedAgent) return;
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/livekit/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentName: selectedAgent.dispatchName }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Token error: ${res.status}`);
      }
      const bundle = await res.json();
      setConnection(bundle);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setConnecting(false);
    }
  }, [selectedAgent]);

  const disconnect = useCallback(() => {
    setConnection(null);
  }, []);

  if (connection) {
    return (
      <LiveKitRoom
        serverUrl={connection.livekitUrl}
        token={connection.token}
        connect={true}
        audio={true}
        onDisconnected={disconnect}
        onError={(err) => { console.error("LiveKit error:", err); setError(String(err)); setConnection(null); }}
        style={{ height: "100vh", background: "var(--bg)" }}
      >
        <ActiveSession
          agentName={selectedAgent?.displayName || "Agent"}
          userName={session.user?.name || "User"}
          onDisconnect={disconnect}
          supportsVision={selectedAgent?.capabilities?.vision ?? false}
        />
        <RoomAudioRenderer />
      </LiveKitRoom>
    );
  }

  return (
    <div style={styles.center}>
      <div style={styles.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <h1 style={{ fontSize: 20 }}>Agent Player</h1>
          <button onClick={() => signOut()} style={styles.ghostBtn}>
            Sign out
          </button>
        </div>

        <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>
          Welcome, {session.user?.name || session.user?.email}
        </p>

        {agents.length === 0 && (
          <div style={{ textAlign: "center", padding: "32px 0" }}>
            <div style={styles.spinner} />
            <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 12 }}>
              Waiting for agents to be deployed...
            </p>
            <p style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 4, opacity: 0.7 }}>
              Polling every 15 seconds
            </p>
          </div>
        )}

        {agents.length > 1 && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>
              Select Agent
            </label>
            <select
              value={selectedAgent?.dispatchName || ""}
              onChange={(e) => {
                const agent = agents.find((a) => a.dispatchName === e.target.value);
                setSelectedAgent(agent || null);
              }}
              style={styles.select}
            >
              <option value="">Choose an agent...</option>
              {agents.map((a) => (
                <option key={a.dispatchName} value={a.dispatchName}>
                  {a.displayName}
                </option>
              ))}
            </select>
          </div>
        )}

        {agents.length === 1 && selectedAgent && (
          <div style={{ ...styles.agentCard, marginBottom: 16 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--success)" }} />
            <span style={{ fontSize: 14 }}>{selectedAgent.displayName}</span>
          </div>
        )}

        {error && (
          <p style={{ color: "var(--error)", fontSize: 13, marginBottom: 12 }}>{error}</p>
        )}

        <button
          onClick={connect}
          disabled={!selectedAgent || connecting}
          style={{
            ...styles.primaryBtn,
            opacity: !selectedAgent || connecting ? 0.5 : 1,
            width: "100%",
          }}
        >
          {connecting ? "Connecting..." : "Start Session"}
        </button>
      </div>
    </div>
  );
}

function ActiveSession({
  agentName,
  userName,
  onDisconnect,
  supportsVision,
}: {
  agentName: string;
  userName: string;
  onDisconnect: () => void;
  supportsVision: boolean;
}) {
  const connectionState = useConnectionState();
  const voiceAssistant = useVoiceAssistant();
  const { chatMessages, send: sendChat } = useChat();
  const { localParticipant } = useLocalParticipant();
  const [chatInput, setChatInput] = useState("");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(false);
  const [screenEnabled, setScreenEnabled] = useState(false);

  const toggleMic = async () => {
    await localParticipant.setMicrophoneEnabled(!micEnabled);
    setMicEnabled(!micEnabled);
  };
  const toggleCam = async () => {
    await localParticipant.setCameraEnabled(!camEnabled);
    setCamEnabled(!camEnabled);
  };
  const toggleScreen = async () => {
    if (screenEnabled) {
      // Can't programmatically stop screen share — disconnect and reconnect
      setScreenEnabled(false);
    } else {
      await localParticipant.setScreenShareEnabled(true);
      setScreenEnabled(true);
    }
  };

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const handleSendChat = () => {
    const msg = chatInput.trim();
    if (!msg) return;
    sendChat(msg);
    setChatInput("");
  };

  if (connectionState === ConnectionState.Connecting) {
    return <LoadingScreen message="Connecting to agent..." />;
  }

  return (
    <div style={styles.sessionContainer}>
      {/* Header */}
      <header style={styles.header}>
        <div>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{agentName}</span>
          <span style={{ color: "var(--text-muted)", fontSize: 12, marginLeft: 8 }}>
            {connectionState === ConnectionState.Connected ? "Connected" : connectionState}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{userName}</span>
          <button onClick={onDisconnect} style={styles.disconnectBtn}>
            End
          </button>
        </div>
      </header>

      {/* Media Controls */}
      <div style={styles.controlBar}>
        <button onClick={toggleMic} style={{ ...styles.controlBtn, background: micEnabled ? "var(--accent)" : "var(--bg-hover)" }}>
          {micEnabled ? "\uD83C\uDF99\uFE0F Mic On" : "\uD83D\uDD07 Mic Off"}
        </button>
        {supportsVision && (
          <button onClick={toggleCam} style={{ ...styles.controlBtn, background: camEnabled ? "var(--accent)" : "var(--bg-hover)" }}>
            {camEnabled ? "\uD83D\uDCF7 Cam On" : "\uD83D\uDEAB Cam Off"}
          </button>
        )}
        {supportsVision && (
          <button onClick={toggleScreen} style={{ ...styles.controlBtn, background: screenEnabled ? "var(--accent)" : "var(--bg-hover)" }}>
            {screenEnabled ? "\uD83D\uDDA5\uFE0F Sharing" : "\uD83D\uDDA5\uFE0F Share Screen"}
          </button>
        )}
      </div>

      {/* Main content */}
      <div style={styles.mainContent}>
        {/* Audio visualizer */}
        <div style={styles.visualizerArea}>
          {voiceAssistant.audioTrack && (
            <BarVisualizer
              state={voiceAssistant.state}
              barCount={7}
              trackRef={voiceAssistant.audioTrack}
              style={{ width: 200, height: 100 }}
            />
          )}
          {!voiceAssistant.audioTrack && (
            <div style={{ color: "var(--text-muted)", fontSize: 14 }}>
              {voiceAssistant.state === "connecting"
                ? "Agent connecting..."
                : voiceAssistant.state === "listening"
                  ? "Listening..."
                  : "Waiting for agent..."}
            </div>
          )}
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 8 }}>
            {voiceAssistant.state === "speaking"
              ? "Agent speaking"
              : voiceAssistant.state === "thinking"
                ? "Agent thinking..."
                : voiceAssistant.state === "listening"
                  ? "Listening"
                  : ""}
          </div>
        </div>

        {/* Chat transcript */}
        <div style={styles.chatPanel}>
          <div style={styles.chatHeader}>Chat</div>
          <div ref={transcriptRef} style={styles.chatMessages}>
            {chatMessages.length === 0 && (
              <p style={{ color: "var(--text-muted)", fontSize: 13, textAlign: "center", marginTop: 32 }}>
                Start speaking or type a message below
              </p>
            )}
            {chatMessages.map((msg, i) => {
              const isAgent = msg.from?.identity !== userName;
              return (
                <div
                  key={i}
                  style={{
                    ...styles.chatBubble,
                    background: isAgent ? "var(--agent-bubble)" : "var(--user-bubble)",
                    alignSelf: isAgent ? "flex-start" : "flex-end",
                  }}
                >
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>
                    {isAgent ? agentName : "You"}
                  </div>
                  <div style={{ fontSize: 14, lineHeight: 1.5 }}>{msg.message}</div>
                </div>
              );
            })}
          </div>

          {/* Chat input */}
          <div style={styles.chatInputArea}>
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSendChat()}
              placeholder="Type a message..."
              style={styles.chatInput}
            />
            <button onClick={handleSendChat} style={styles.sendBtn}>
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  center: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100vh",
    flexDirection: "column",
  },
  card: {
    background: "var(--bg-card)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 32,
    width: 380,
    maxWidth: "90vw",
  },
  primaryBtn: {
    background: "var(--accent)",
    color: "white",
    padding: "10px 20px",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 500,
    transition: "background 0.2s",
  },
  ghostBtn: {
    background: "transparent",
    color: "var(--text-muted)",
    padding: "6px 12px",
    borderRadius: 6,
    fontSize: 12,
    border: "1px solid var(--border)",
  },
  select: {
    width: "100%",
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 14,
    outline: "none",
  },
  agentCard: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 14px",
    background: "var(--bg)",
    borderRadius: 8,
    border: "1px solid var(--border)",
  },
  spinner: {
    width: 24,
    height: 24,
    border: "2px solid var(--border)",
    borderTopColor: "var(--accent)",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
    margin: "0 auto",
  },
  sessionContainer: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: "var(--bg)",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 20px",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg-card)",
  },
  controlBar: {
    display: "flex",
    gap: 8,
    padding: "8px 20px",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg-card)",
  },
  controlBtn: {
    color: "white",
    padding: "6px 12px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 500,
    transition: "background 0.2s",
  },
  disconnectBtn: {
    background: "var(--error)",
    color: "white",
    padding: "6px 14px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 500,
  },
  mainContent: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  },
  visualizerArea: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  chatPanel: {
    width: 360,
    borderLeft: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    background: "var(--bg-card)",
  },
  chatHeader: {
    padding: "12px 16px",
    borderBottom: "1px solid var(--border)",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: 1,
  },
  chatMessages: {
    flex: 1,
    overflowY: "auto" as const,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  chatBubble: {
    padding: "8px 12px",
    borderRadius: 10,
    maxWidth: "85%",
  },
  chatInputArea: {
    display: "flex",
    gap: 8,
    padding: 12,
    borderTop: "1px solid var(--border)",
  },
  chatInput: {
    flex: 1,
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 14,
    outline: "none",
  },
  sendBtn: {
    background: "var(--accent)",
    color: "white",
    padding: "8px 16px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
  },
};
