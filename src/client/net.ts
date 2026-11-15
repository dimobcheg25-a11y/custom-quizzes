import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, GameEvent, GameView, ServerMessage } from '../shared/protocol';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'fatal';

export interface GameConnection {
  state?: GameView;
  status: ConnStatus;
  fatalError?: string;
  kicked: boolean;
  send: (m: ClientMessage) => void;
  /** Server time estimate in ms. */
  serverNow: () => number;
}

type Listener = (e: { name: GameEvent; playerId?: string }) => void;

export function useGameConnection(query: Record<string, string> | null, onEvent?: Listener, onError?: (m: string) => void): GameConnection {
  const [state, setState] = useState<GameView>();
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [fatalError, setFatal] = useState<string>();
  const [kicked, setKicked] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const offset = useRef(0);
  const bestRtt = useRef(Infinity);
  const pingSent = useRef(0);
  const handlers = useRef({ onEvent, onError });
  handlers.current = { onEvent, onError };
  const key = query ? new URLSearchParams(query).toString() : '';

  useEffect(() => {
    if (!query) return;
    let closed = false;
    let retry = 0;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?${key}`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setStatus('open');
        const ping = () => {
          pingSent.current = Date.now();
          ws.send(JSON.stringify({ t: 'ping' }));
        };
        ping();
        pingTimer = setInterval(ping, 10_000);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as ServerMessage & { fatal?: boolean };
        if (msg.t === 'state') {
          if (bestRtt.current === Infinity) offset.current = msg.state.serverNow - Date.now();
          setState(msg.state);
        } else if (msg.t === 'pong') {
          const rtt = Date.now() - pingSent.current;
          if (rtt <= bestRtt.current * 1.5 || rtt < 80) {
            bestRtt.current = Math.min(bestRtt.current, rtt);
            offset.current = msg.serverNow + rtt / 2 - Date.now();
          }
        } else if (msg.t === 'event') {
          handlers.current.onEvent?.({ name: msg.name, playerId: msg.playerId });
        } else if (msg.t === 'error') {
          if (msg.fatal) {
            closed = true;
            setFatal(msg.message);
            setStatus('fatal');
          } else handlers.current.onError?.(msg.message);
        } else if (msg.t === 'kicked') {
          closed = true;
          setKicked(true);
        }
      };
      ws.onclose = () => {
        clearInterval(pingTimer);
        if (closed) return;
        setStatus('reconnecting');
        retryTimer = setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const send = useCallback((m: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }, []);

  const serverNow = useCallback(() => Date.now() + offset.current, []);

  return { state, status, fatalError, kicked, send, serverNow };
}

/** Re-render every `ms` while `active`. */
export function useTicker(active: boolean, ms = 100) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [active, ms]);
}

export function randomToken() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode */
    }
  },
};
