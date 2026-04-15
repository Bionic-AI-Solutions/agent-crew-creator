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
  useRemoteParticipants,
  BarVisualizer,
  VideoTrack,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { ConnectionState, Track } from "livekit-client";
import { marked } from "marked";

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
  clientId?: string;
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
  const [clientId, setClientId] = useState("");

  // Pre-fill clientId from URL param (e.g., ?clientId=LOAN-123)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlClientId = params.get("clientId");
    if (urlClientId) setClientId(urlClientId);
  }, []);

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
        body: JSON.stringify({ agentName: selectedAgent.dispatchName, clientId: clientId.trim() || undefined }),
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

        {/* Client reference (optional — for session continuity) */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 6 }}>
            Client Reference (optional)
          </label>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="e.g., LOAN-2026-4821"
            style={styles.chatInput || { width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 13, outline: "none" }}
          />
          <p style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4, opacity: 0.7 }}>
            Enter a client ID to continue a previous session
          </p>
        </div>

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

/** Parse a chat message — detect JSON artifacts (images, PDFs) embedded in text */
function parseMessageContent(raw: string): { type: "text" | "image" | "artifact"; html: string; imageUrl?: string; title?: string }[] {
  const results: { type: "text" | "image" | "artifact"; html: string; imageUrl?: string; title?: string }[] = [];

  // Filter out internal Letta noise
  if (raw.startsWith("*(No output") || raw.startsWith("*(Waiting")) {
    return [];
  }

  // Try parsing entire message as JSON artifact
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed.url || parsed.download_url || parsed.image_url) {
      const url = parsed.url || parsed.download_url || parsed.image_url;
      if (parsed.content_type?.startsWith("image/") || url.match(/\.(png|jpg|jpeg|gif|webp)/i)) {
        return [{ type: "image", html: "", imageUrl: url, title: parsed.summary || parsed.title || "" }];
      }
      if (parsed.filename?.endsWith(".pdf")) {
        return [{ type: "artifact", html: `<a href="${url}" target="_blank" style="color:var(--accent)">📄 ${parsed.filename}</a> (${parsed.pages || "?"} pages)` }];
      }
    }
    if (parsed.error) {
      return [{ type: "text", html: `<span style="color:var(--error)">⚠️ ${parsed.error}</span>` }];
    }
  } catch {
    // Not pure JSON — check for embedded JSON within text
  }

  // Split message line by line — check each line for JSON artifacts
  const lines = raw.split("\n");
  let textBuffer = "";

  for (const line of lines) {
    const trimmed = line.trim();
    // Try to parse as JSON if it starts with {
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        // Flush text buffer first
        if (textBuffer.trim()) {
          const html = marked.parse(textBuffer, { breaks: true, gfm: true }) as string;
          if (html.trim()) results.push({ type: "text", html });
          textBuffer = "";
        }
        // Handle artifact
        const url = parsed.url || parsed.download_url || parsed.image_url;
        if (url && (parsed.content_type?.startsWith("image/") || url.match(/\.(png|jpg|jpeg|gif|webp)/i))) {
          results.push({ type: "image", html: "", imageUrl: url, title: parsed.summary || parsed.title || "" });
        } else if (parsed.error) {
          results.push({ type: "text", html: `<span style="color:var(--error)">⚠️ ${parsed.error}</span>` });
        } else if (url) {
          results.push({ type: "artifact", html: `<a href="${url}" target="_blank" style="color:var(--accent)">📎 ${parsed.filename || "Download"}</a>` });
        } else {
          textBuffer += line + "\n"; // Not a recognized artifact, treat as text
        }
        continue;
      } catch {
        // Not valid JSON — check if it's an inline artifact like {"type":"artifact",...}
      }
    }

    // Also check for inline JSON within text (e.g., "here is an image: {json}")
    const jsonMatch = trimmed.match(/\{[^{}]*"(?:url|image_url|download_url)"[^}]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const url = parsed.url || parsed.download_url || parsed.image_url;
        if (url && url.match(/\.(png|jpg|jpeg|gif|webp|pdf)/i)) {
          // Flush text before the JSON
          const beforeJson = trimmed.slice(0, trimmed.indexOf(jsonMatch[0])).trim();
          if (beforeJson) textBuffer += beforeJson + "\n";
          if (textBuffer.trim()) {
            const html = marked.parse(textBuffer, { breaks: true, gfm: true }) as string;
            if (html.trim()) results.push({ type: "text", html });
            textBuffer = "";
          }
          if (url.match(/\.(png|jpg|jpeg|gif|webp)/i)) {
            results.push({ type: "image", html: "", imageUrl: url, title: parsed.summary || parsed.title || "" });
          } else {
            results.push({ type: "artifact", html: `<a href="${url}" target="_blank" style="color:var(--accent)">📎 ${parsed.filename || "Download"}</a>` });
          }
          continue;
        }
      } catch {}
    }

    textBuffer += line + "\n";
  }

  // Flush remaining text
  if (textBuffer.trim()) {
    const html = marked.parse(textBuffer, { breaks: true, gfm: true }) as string;
    if (html.trim()) results.push({ type: "text", html });
  }

  return results;
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
  const remoteParticipants = useRemoteParticipants();
  const [chatInput, setChatInput] = useState("");
  const presentationRef = useRef<HTMLDivElement>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(false);
  const [screenEnabled, setScreenEnabled] = useState(false);
  const [fileUploading, setFileUploading] = useState(false);

  const toggleMic = async () => { await localParticipant.setMicrophoneEnabled(!micEnabled); setMicEnabled(!micEnabled); };
  const toggleCam = async () => { await localParticipant.setCameraEnabled(!camEnabled); setCamEnabled(!camEnabled); };
  const toggleScreen = async () => {
    if (screenEnabled) { setScreenEnabled(false); }
    else { await localParticipant.setScreenShareEnabled(true); setScreenEnabled(true); }
  };

  // Auto-scroll presentation area
  useEffect(() => {
    if (presentationRef.current) {
      presentationRef.current.scrollTop = presentationRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const handleSendChat = () => {
    const msg = chatInput.trim();
    if (!msg) return;
    sendChat(msg);
    setChatInput("");
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileUploading(true);
    try {
      // Send file name as chat message to trigger document processing
      sendChat(`[Uploading document: ${file.name}]`);
      // TODO: actual file upload via platform API
    } finally {
      setFileUploading(false);
    }
  };

  // Find avatar video track — BitHuman avatar joins as "bithuman-avatar-agent"
  const avatarParticipant = remoteParticipants.find((p) => p.identity === "bithuman-avatar-agent");
  const avatarVideoTrack = avatarParticipant?.getTrackPublication(Track.Source.Camera);
  // Fallback: any remote participant with a camera (for non-BitHuman avatars)
  const agentParticipant = avatarParticipant ?? remoteParticipants.find((p) =>
    p.identity.startsWith("agent-") && p.getTrackPublication(Track.Source.Camera)
  );
  const agentVideoTrack = avatarVideoTrack ?? agentParticipant?.getTrackPublication(Track.Source.Camera);

  // Parse agent messages for the presentation screen
  const agentMessages = chatMessages
    .filter((msg) => msg.from?.identity !== localParticipant.identity)
    .flatMap((msg) => parseMessageContent(msg.message))
    .filter((m) => m.html || m.imageUrl); // Skip empty

  if (connectionState === ConnectionState.Connecting) {
    return <LoadingScreen message="Connecting to agent..." />;
  }

  return (
    <div style={cls.root}>
      {/* ── Header ── */}
      <header style={cls.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{agentName}</span>
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
            {connectionState === ConnectionState.Connected ? "Connected" : connectionState}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Media controls */}
          <button onClick={toggleMic} style={{ ...cls.ctrlBtn, background: micEnabled ? "var(--accent)" : "var(--bg-hover)" }}>
            {micEnabled ? "🎙️ Mic On" : "🔇 Mic Off"}
          </button>
          {supportsVision && (
            <button onClick={toggleCam} style={{ ...cls.ctrlBtn, background: camEnabled ? "var(--accent)" : "var(--bg-hover)" }}>
              {camEnabled ? "📷 Cam On" : "🚫 Cam Off"}
            </button>
          )}
          {supportsVision && (
            <button onClick={toggleScreen} style={{ ...cls.ctrlBtn, background: screenEnabled ? "var(--accent)" : "var(--bg-hover)" }}>
              🖥️ Share
            </button>
          )}
          {/* Document upload */}
          <label style={{ ...cls.ctrlBtn, background: "var(--bg-hover)", cursor: "pointer" }}>
            📎 {fileUploading ? "..." : "Upload"}
            <input type="file" accept=".pdf,.docx,.txt,.md,.csv" style={{ display: "none" }} onChange={handleFileUpload} />
          </label>

          <span style={{ color: "var(--text-muted)", fontSize: 11, marginLeft: 8 }}>{userName}</span>
          <button onClick={onDisconnect} style={cls.endBtn}>End</button>
        </div>
      </header>

      {/* ── Main classroom area ── */}
      <div style={cls.classroom}>

        {/* ── Left: Avatar + Agent State ── */}
        <div style={cls.leftPanel}>
          {/* Avatar video */}
          <div style={cls.avatarBox}>
            {agentVideoTrack?.track && agentParticipant ? (
              <VideoTrack trackRef={{ participant: agentParticipant, publication: agentVideoTrack, source: Track.Source.Camera }}
                style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 8 }} />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%" }}>
                {voiceAssistant.audioTrack && (
                  <BarVisualizer state={voiceAssistant.state} barCount={5} trackRef={voiceAssistant.audioTrack}
                    style={{ width: 100, height: 60 }} />
                )}
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 8 }}>
                  {voiceAssistant.state === "speaking" ? "Speaking" : voiceAssistant.state === "thinking" ? "Thinking..." : voiceAssistant.state === "listening" ? "Listening" : "Connecting..."}
                </div>
              </div>
            )}
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, textAlign: "center", marginTop: 6 }}>{agentName}</div>
        </div>

        {/* ── Center: Presentation Screen ── */}
        <div style={cls.presentationArea}>
          <div ref={presentationRef} style={cls.presentationScroll}>
            {agentMessages.length === 0 && (
              <div style={{ color: "var(--text-muted)", fontSize: 14, textAlign: "center", marginTop: 60 }}>
                Session started. Ask a question or start a topic.
              </div>
            )}
            {agentMessages.map((msg, i) => (
              <div key={i} style={cls.slide}>
                {msg.type === "image" && msg.imageUrl && (
                  <div style={{ marginBottom: 12 }}>
                    <img src={msg.imageUrl} alt={msg.title || "Generated image"} style={cls.slideImage} />
                    {msg.title && <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, textAlign: "center" }}>{msg.title}</p>}
                  </div>
                )}
                {msg.html && (
                  <div
                    className="slide-content"
                    dangerouslySetInnerHTML={{ __html: msg.html }}
                    style={cls.slideText}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Bottom: Chat input bar ── */}
      <div style={cls.chatBar}>
        <input
          type="text"
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSendChat()}
          placeholder="Ask a question..."
          style={cls.chatInput}
        />
        <button onClick={handleSendChat} style={cls.sendBtn}>Send</button>
      </div>
    </div>
  );
}

// ── Classroom layout styles ──────────────────────────────────
const cls: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)" },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "8px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-card)",
  },
  ctrlBtn: { color: "white", padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 4 },
  endBtn: { background: "var(--error)", color: "white", padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 500 },
  classroom: { display: "flex", flex: 1, overflow: "hidden" },
  leftPanel: {
    width: 200, padding: 16, borderRight: "1px solid var(--border)", background: "var(--bg-card)",
    display: "flex", flexDirection: "column", alignItems: "center",
  },
  avatarBox: {
    width: 168, height: 168, borderRadius: 12, overflow: "hidden",
    background: "var(--bg)", border: "2px solid var(--border)",
  },
  presentationArea: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  presentationScroll: { flex: 1, overflowY: "auto" as const, padding: "24px 32px" },
  slide: { marginBottom: 24, paddingBottom: 20, borderBottom: "1px solid var(--border)" },
  slideImage: { maxWidth: "100%", maxHeight: 400, borderRadius: 8, border: "1px solid var(--border)" },
  slideText: { fontSize: 15, lineHeight: 1.7, color: "var(--text)" },
  chatBar: {
    display: "flex", gap: 8, padding: "10px 16px",
    borderTop: "1px solid var(--border)", background: "var(--bg-card)",
  },
  chatInput: {
    flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)",
    background: "var(--bg)", color: "var(--text)", fontSize: 13, outline: "none",
  },
  sendBtn: { background: "var(--accent)", color: "white", padding: "8px 16px", borderRadius: 8, fontSize: 12, fontWeight: 500 },
};

// Keep old styles for the login/welcome screens
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
