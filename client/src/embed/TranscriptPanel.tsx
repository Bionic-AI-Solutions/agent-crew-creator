import { useEffect, useRef, useMemo } from "react";
import {
  type ReceivedChatMessage,
  type TextStreamData,
  useChat,
  useRoomContext,
  useTranscriptions,
} from "@livekit/components-react";
import type { Room } from "livekit-client";
import { ChatMessage } from "./ChatMessage";
import type { EmbedConfig } from "./types";

function transcriptionToChatMessage(
  textStream: TextStreamData,
  room: Room,
): ReceivedChatMessage {
  return {
    id: textStream.streamInfo.id,
    timestamp: textStream.streamInfo.timestamp,
    message: textStream.text,
    from:
      textStream.participantInfo.identity === room.localParticipant.identity
        ? room.localParticipant
        : Array.from(room.remoteParticipants.values()).find(
            (p) => p.identity === textStream.participantInfo.identity,
          ),
  };
}

interface TranscriptPanelProps {
  config: EmbedConfig;
  onSendMessage?: (message: string) => Promise<void>;
}

export function TranscriptPanel({ config, onSendMessage }: TranscriptPanelProps) {
  const room = useRoomContext();
  const transcriptions: TextStreamData[] = useTranscriptions();
  const { chatMessages, send } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(() => {
    const merged: ReceivedChatMessage[] = [];

    // Add transcriptions only if showTranscription is enabled
    if (config.showTranscription) {
      merged.push(
        ...transcriptions.map((t) => transcriptionToChatMessage(t, room)),
      );
    }

    // Always add chat messages (Letta output)
    merged.push(...chatMessages);

    return merged.sort((a, b) => a.timestamp - b.timestamp);
  }, [transcriptions, chatMessages, room, config.showTranscription]);

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
