import { useEffect, useRef, useState } from "react";
import type { Conn } from "./api";
import { api } from "./api";

export interface LiveEvent {
  type: string;
  station?: string;
  shipGuid?: string;
  active?: boolean;
  // "log" events
  t?: string;
  source?: string;
  text?: string;
}

// Subscribe to the bridge SSE feed. Calls onEvent for each event; exposes the last one + echo state.
export function useEvents(conn: Conn, enabled: boolean, onEvent: (e: LiveEvent) => void) {
  const [last, setLast] = useState<LiveEvent | null>(null);
  const [connected, setConnected] = useState(false);
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource(api.eventsUrl(conn));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as LiveEvent;
        setLast(e);
        cb.current(e);
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => es.close();
    // Reconnect when the target URL changes.
  }, [conn.host, conn.port, conn.token, enabled]);

  return { last, connected };
}
