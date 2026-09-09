/**
 * Subscribe to a LiveKit text-stream topic.
 *
 * This exists because `useTextStream` / `useTranscriptions` from
 * @livekit/components-react do not register their handler in this app, so
 * every topic they own is silently dropped. Measured against the live room on
 * 2026-09-09: the agent publishes `lk.transcription` correctly (confirmed by
 * joining the room as a third participant and reading the stream), yet
 * `room.incomingDataStreamManager.textStreamHandlers` held only
 * `lk.rpc_request`, `lk.rpc_response` and `lk.chat` -- the three topics those
 * hooks are responsible for were absent. Publishing a probe on `lk.chat`
 * rendered; the same probe on `lk.transcription` did not. Registering a
 * handler by hand on that same room received the agent's next utterance
 * immediately, which is what this hook does.
 *
 * The library's version registers lazily, inside an rxjs `tap({subscribe})`
 * behind a module-level cache and `share()`, so registration depends on a
 * refCount transition that never happened here. This one registers directly
 * in an effect, where it either happens or throws.
 *
 * Upgrading the SDK is not the fix: `useTextStream.ts` is byte-identical
 * between 2.9.21 (deployed) and 2.9.24 (latest), and a `@livekit/protocol`
 * override pins us below what a newer `livekit-client` needs.
 *
 * The returned shape matches the library's `TextStreamData` so call sites read
 * the same either way.
 */
import { useEffect, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import type { Room } from "livekit-client";

export interface TopicTextStreamData {
  text: string;
  participantInfo: { identity: string };
  streamInfo: {
    id: string;
    timestamp: number;
    attributes?: Record<string, string>;
  };
}

/** Set by the agent so interim and final text for one utterance coalesce. */
const SEGMENT_ID_ATTRIBUTE = "lk.segment_id";

type Listener = (streams: TopicTextStreamData[]) => void;

interface TopicRegistry {
  streams: TopicTextStreamData[];
  listeners: Set<Listener>;
}

/** Per-room, per-topic. WeakMap so a finished room is collectable. */
const roomRegistries = new WeakMap<Room, Map<string, TopicRegistry>>();

function getRegistry(room: Room, topic: string): TopicRegistry | undefined {
  return roomRegistries.get(room)?.get(topic);
}

function emit(registry: TopicRegistry) {
  const snapshot = [...registry.streams];
  for (const listener of registry.listeners) listener(snapshot);
}

/**
 * Merge a stream update into the registry.
 *
 * Matched on stream id, or on segment id when the agent supplies one: a single
 * utterance can arrive as several streams (interim then final), and keying on
 * stream id alone would render the same sentence two or three times.
 */
function upsert(
  registry: TopicRegistry,
  entry: TopicTextStreamData,
  segmentId: string | undefined,
) {
  const index = registry.streams.findIndex(
    (existing) =>
      existing.streamInfo.id === entry.streamInfo.id ||
      (!!segmentId &&
        existing.streamInfo.attributes?.[SEGMENT_ID_ATTRIBUTE] === segmentId),
  );
  if (index === -1) registry.streams.push(entry);
  else registry.streams[index] = entry;
  emit(registry);
}

/**
 * Register the handler once per room and topic, and keep it registered.
 *
 * Deliberately not reference-counted down to zero. Unregistering when the last
 * subscriber leaves is exactly the pattern that fails in the library version,
 * and a handler that outlives its subscribers costs one closure, while one
 * that is missing costs the user the agent's words. The room drops it on
 * disconnect regardless.
 */
function ensureRegistered(room: Room, topic: string): TopicRegistry {
  let byTopic = roomRegistries.get(room);
  if (!byTopic) {
    byTopic = new Map();
    roomRegistries.set(room, byTopic);
  }
  const existing = byTopic.get(topic);
  if (existing) return existing;

  const registry: TopicRegistry = { streams: [], listeners: new Set() };
  byTopic.set(topic, registry);

  const handler = async (
    reader: {
      info: { id: string; timestamp: number; attributes?: Record<string, string> };
      [Symbol.asyncIterator](): AsyncIterator<string>;
    },
    participantInfo: { identity: string },
  ) => {
    const attributes = reader.info.attributes ?? {};
    const segmentId = attributes[SEGMENT_ID_ATTRIBUTE];
    let text = "";
    try {
      for await (const chunk of reader) {
        text += chunk;
        // Emit as it arrives rather than at close, so a long spoken answer
        // fills in while it is being said instead of appearing all at once.
        upsert(
          registry,
          {
            text,
            participantInfo: { identity: participantInfo.identity },
            streamInfo: {
              id: reader.info.id,
              timestamp: reader.info.timestamp,
              attributes,
            },
          },
          segmentId,
        );
      }
    } catch (error) {
      // A reader that errors mid-stream leaves whatever arrived already
      // rendered, which beats discarding a half-received answer.
      console.warn(`[${topic}] stream ${reader.info.id} ended early:`, error);
    }
  };

  try {
    room.registerTextStreamHandler(topic, handler as never);
  } catch {
    // The topic is already claimed. In this app that means a stale handler
    // from a previous mount, since nothing else subscribes to these topics --
    // take it over rather than leaving the panel silent.
    try {
      room.unregisterTextStreamHandler(topic);
      room.registerTextStreamHandler(topic, handler as never);
    } catch (error) {
      console.error(`[${topic}] could not register a text stream handler:`, error);
    }
  }

  return registry;
}

/**
 * Text streams received on `topic`, oldest first, updating as they arrive.
 */
export function useTopicTextStream(topic: string): TopicTextStreamData[] {
  const room = useRoomContext();
  const [streams, setStreams] = useState<TopicTextStreamData[]>([]);

  useEffect(() => {
    if (!room) return;
    const registry = ensureRegistered(room, topic);
    registry.listeners.add(setStreams);
    // Anything that arrived before this mount is already in the registry.
    setStreams([...registry.streams]);
    return () => {
      getRegistry(room, topic)?.listeners.delete(setStreams);
    };
  }, [room, topic]);

  return streams;
}

/** The agent's and the user's speech, as published by the agent worker. */
export function useTranscriptionStream(): TopicTextStreamData[] {
  return useTopicTextStream("lk.transcription");
}
