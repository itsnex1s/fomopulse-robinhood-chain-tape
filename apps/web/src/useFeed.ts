import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTape } from "./store.ts";
import type { Fill } from "./types.ts";

export type Feed = "connecting" | "live" | "reconnecting";

/**
 * One socket for the whole app. It writes straight into the tape store instead of
 * React state, so a new fill re-renders one row and nothing else.
 */
export function useFeed(): Feed {
  const [feed, setFeed] = useState<Feed>("connecting");
  const client = useQueryClient();

  useEffect(() => {
    let socket: WebSocket | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let dropped = false;

    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${location.host}/ws`);
      socket.onopen = () => {
        setFeed("live");
        // Fills and reprices sent while the socket was away are not replayed, and the tape
        // query is otherwise fetched once and left alone. Without this read the screen keeps
        // rows the server corrected minutes ago — a stock fill priced on the next tick sits
        // at "—" until the page is reloaded by hand.
        if (dropped) void client.invalidateQueries({ queryKey: ["tape"] });
        dropped = false;
        ping = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send("p"), 20_000);
      };
      socket.onmessage = (event) => {
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
