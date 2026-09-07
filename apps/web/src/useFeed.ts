import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTape } from "./store.ts";
import type { Fill } from "./types.ts";

export type Feed = "connecting" | "live" | "reconnecting";

/** How often the socket is poked. The server answers a bare "p" with one. */
const PING_MS = 20_000;
/** No answer and no fill for this long means a socket that is open only on this side. */
const SILENT_MS = 3 * PING_MS;

/** Whether a socket that last carried something at `heard` has gone quiet for too long. */
export const silent = (heard: number, now: number): boolean => now - heard > SILENT_MS;

/** One socket for the whole app; it writes into the tape store, so a new fill re-renders one row. */
export function useFeed(): Feed {
  const [feed, setFeed] = useState<Feed>("connecting");
  const client = useQueryClient();

  useEffect(() => {
    let socket: WebSocket | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let dropped = false;
    // A TCP connection can be half open — the laptop woke on a different network, a captive
    // portal swallowed the link — and nothing tells this side. The socket stays OPEN, onclose
    // never fires, and the tape sits frozen under a live indicator. The pong is the proof.
    let heard = 0;

    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${location.host}/ws`);
      socket.onopen = () => {
        setFeed("live");
        // Fills and reprices sent while the socket was away are not replayed, and the tape
        // query is otherwise fetched once and left alone.
        if (dropped) void client.invalidateQueries({ queryKey: ["tape"] });
        dropped = false;
        heard = Date.now();
        ping = setInterval(() => {
          if (socket?.readyState !== WebSocket.OPEN) return;
          if (silent(heard, Date.now())) {
            // close() runs onclose, which reconnects and marks the feed as such.
            socket.close();
            return;
          }
          socket.send("p");
        }, PING_MS);
      };
      socket.onmessage = (event) => {
        heard = Date.now();
        if (event.data === "p") return;
        const message = JSON.parse(event.data as string) as { type: string; data: Fill[] };
        if (message.type === "fills") useTape.getState().push(message.data);
      };
      socket.onclose = () => {
        clearInterval(ping);
        if (done) return;
        dropped = true;
        setFeed("reconnecting");
        retry = setTimeout(connect, 2_000);
      };
    };

    connect();
    return () => {
      done = true;
      clearInterval(ping);
      clearTimeout(retry);
      socket?.close();
    };
  }, [client]);

  return feed;
}
