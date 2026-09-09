import { useEffect, useRef, useMemo } from "react";
import {
  useChat,
  useRoomContext,
  useTextStream,
  useTranscriptions,
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
  const transcriptions = useTranscriptions();
  // The delegation worker publishes its findings to lk.chat.summary. Nothing
  // in this app subscribed to that topic, so results the secondary agent
  // produced were sent and then dropped on the floor -- the user only ever
  // saw them if the primary happened to read them aloud afterwards.
  const { textStreams: summaries } = useTextStream("lk.chat.summary");
  // ...and the illustrations that go with them. The agent is prompted to say
  // "as you can see in the diagram on screen", and for an embed user there was
  // no screen: this topic had no subscriber anywhere in client/, so generated
  // images and artifacts were published and discarded. ChatMessage already
  // parses the artifact JSON and renders image previews, so they only needed
  // routing here.
  const { textStreams: visuals } = useTextStream("lk.chat.presentation");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Two streams, one panel, ordered together.
  //
  // This used to render lk.chat alone, on the reasoning that users hear the
  // agent speak and do not need a text duplicate. But nothing the agent sends
  // arrives on bare lk.chat: the delegation worker publishes to
  // lk.chat.summary and lk.chat.presentation, and useChat() subscribes only to
  // the default "lk.chat" topic. So chatMessages has only ever carried the
  // user's own typed input, and the panel could never show the agent at all.
  //
  // A text duplicate is not redundant either: it is the record of what was
  // said, how a returning user catches up, and the only readable form when
  // audio is muted or missed.
  const messages = useMemo(() => {
    const chat = chatMessages.map((m) => ({
      kind: "chat" as const,
      id: m.id,
      ts: m.timestamp,
      text: m.message,
      identity: m.from?.identity,
      name: m.from?.name || m.from?.identity,
    }));
    const spoken = transcriptions.map((t) => {
      // useTranscriptions() carries every participant's speech, not just the
      // agent's, so resolve the name rather than labelling the speaker
      // "Agent" -- in a room with a second person that label would be a lie.
      const identity = t.participantInfo.identity;
      const p = identity === room.localParticipant.identity
        ? room.localParticipant
        : room.remoteParticipants.get(identity);
      return {
        kind: "transcript" as const,
        id: t.streamInfo.id,
        // Both timestamps are Date.now()-based epoch ms (BaseStreamInfo for
        // transcripts, the same basis for chat), so the two interleave in the
        // order things actually happened.
        ts: t.streamInfo.timestamp,
        text: t.text,
        identity,
        name: p?.name || identity,
      };
    });
    const results = summaries.map((t) => ({
      kind: "summary" as const,
      id: t.streamInfo.id,
      ts: t.streamInfo.timestamp,
      text: t.text,
      identity: t.participantInfo.identity,
      name: "Assistant findings",
    }));
    const illustrations = visuals.map((t) => ({
      kind: "presentation" as const,
      id: t.streamInfo.id,
      ts: t.streamInfo.timestamp,
      text: t.text,
      identity: t.participantInfo.identity,
      name: "Assistant illustration",
    }));
    return [...chat, ...spoken, ...results, ...illustrations]
      .sort((a, b) => a.ts - b.ts);
  }, [chatMessages, transcriptions, summaries, visuals, room]);

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
            const isLocal = msg.identity === room.localParticipant.identity;
            const name = isLocal ? "You" : msg.name || "Agent";
            return (
              <ChatMessage
                key={`${msg.kind}:${msg.id}`}
                message={msg.text}
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
