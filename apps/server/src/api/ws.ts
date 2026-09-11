import type { ServerWebSocket } from "bun";
import { tail } from "./fills.ts";

const TOPIC = "fills";

/** Clients keep the socket alive with a bare "p" every 20 s, as the original does. */
export const websocket = {
  open(ws: ServerWebSocket<undefined>) {
    ws.subscribe(TOPIC);
    // The page this reader is about to draw may have come from a cache; these are the fills
    // that landed after that snapshot was taken, so the gap closes on its own.
    const rows = tail();
    if (rows.length > 0) ws.send(JSON.stringify({ type: "fills", data: rows }));
  },
  message(ws: ServerWebSocket<undefined>, message: string | Buffer) {
    if (message.toString() === "p") ws.send("p");
  },
  close(ws: ServerWebSocket<undefined>) {
    ws.unsubscribe(TOPIC);
  },
};

/** Structural on purpose: only `publish` is needed, and it keeps Bun's generics out. */
export function broadcast(server: { publish: (topic: string, data: string) => unknown }, fills: unknown[]): void {
  if (fills.length > 0) server.publish(TOPIC, JSON.stringify({ type: "fills", data: fills }));
}
