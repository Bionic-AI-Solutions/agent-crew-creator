import { useEffect, useRef, useMemo } from "react";
import {
  type ReceivedChatMessage,
  useChat,
  useRoomContext,
} from "@livekit/components-react";
import { ChatMessage } from "./ChatMessage";
import type { EmbedConfig } from "./types";

interface TranscriptPanelProps {
  config: EmbedConfig;
  /** Platform origin for absolute S3 proxy image URLs (embed on third-party sites). */
  platformOrigin?: string;
  onSendMessage?: (message: string) => Promise<void>;
}

export function TranscriptPanel({ config, platformOrigin, onSendMessage }: TranscriptPanelProps) {
  const room = useRoomContext();
  const { chatMessages, send } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Only show explicit chat messages (lk.chat topic) — Letta output and
  // user-typed messages. Transcriptions (agent TTS, user STT) are NOT
  // mixed in: users hear the agent speak, they don't need a text duplicate.
  const messages = useMemo(() => {
    return [...chatMessages].sort((a, b) => a.timestamp - b.timestamp);
  }, [chatMessages]);

  // Auto-scroll to bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleSend = async (message: string) => {
    if (onSendMessage) {
      await onSendMessage(message);
    } else {
      await send(message);
    }
  };

  return (
    <div className="bionic-transcript-panel">
      <div ref={scrollRef} className="bionic-transcript-scroll">
        <div className="bionic-transcript-messages">
          {messages.map((msg) => {
            const isLocal = msg.from?.identity === room.localParticipant.identity;
            const name = isLocal
              ? "You"
              : msg.from?.name || msg.from?.identity || "Agent";
            return (
              <ChatMessage
                key={msg.id}
                message={msg.message}
                isLocal={isLocal}
                name={name}
                platformOrigin={platformOrigin}
              />
            );
          })}
        </div>
      </div>

      {/* Chat input */}
      <div className="bionic-chat-input-wrapper">
        <ChatInput onSend={handleSend} />
      </div>
    </div>
  );
}

/** Simple chat input with send on Enter. */
function ChatInput({ onSend }: { onSend: (msg: string) => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const value = inputRef.current?.value.trim();
      if (value) {
        inputRef.current!.value = "";
        await onSend(value);
      }
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      placeholder="Type a message..."
      className="bionic-chat-input"
      onKeyDown={handleKeyDown}
    />
  );
}
