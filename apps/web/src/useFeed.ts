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

/** The first wait before reconnecting, and the most any wait grows to. */
const RETRY_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/** The wait after `failures` connects in a row that never opened: doubling to the cap, and half
 *  of it random, so a refusal or a deploy does not bring every open tab back in the same second. */
export const backoff = (failures: number, random: () => number = Math.random): number => {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** failures);
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
};

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
    let failures = 0;
    // A TCP connection can be half open — the laptop woke on a different network, a captive
    // portal swallowed the link — and nothing tells this side. The socket stays OPEN, onclose
    // never fires, and the tape sits frozen under a live indicator. The pong is the proof.
    let heard = 0;

    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${location.host}/ws`);
      socket.onopen = () => {
        failures = 0;
        setFeed("live");
        // Fills and reprices sent while the socket was away are not replayed, and the tape
        // query is otherwise fetched once and left alone.
        if (dropped) void client.invalidateQueries({ queryKey: ["tape"] });
        dropped = false;
        // The page on screen was served from a cache and is a snapshot; this asks for what
        // landed after it was taken, which is the one thing neither the page nor this socket
        // would otherwise carry.
        socket?.send("t");
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
        retry = setTimeout(connect, backoff(failures++));
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
