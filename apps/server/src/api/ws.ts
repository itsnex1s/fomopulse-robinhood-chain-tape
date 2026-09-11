import type { ServerWebSocket } from "bun";
import { tail } from "./fills.ts";

const TOPIC = "fills";

/** Clients keep the socket alive with a bare "p" every 20 s, as the original does. */
export const websocket = {
  open(ws: ServerWebSocket<undefined>) {
    ws.subscribe(TOPIC);
  },
  message(ws: ServerWebSocket<undefined>, message: string | Buffer) {
    const said = message.toString();
    if (said === "p") ws.send("p");
    // The page this reader drew may have come from a cache; these are the fills that landed
    // after that snapshot was taken. Asked for on open, because a socket cannot be told
    // anything until it has finished connecting.
    if (said === "t") {
      const rows = tail();
      if (rows.length > 0) ws.send(JSON.stringify({ type: "fills", data: rows }));
    }
  },
  close(ws: ServerWebSocket<undefined>) {
    ws.unsubscribe(TOPIC);
  },
};

/** Structural on purpose: only `publish` is needed, and it keeps Bun's generics out. */
export function broadcast(server: { publish: (topic: string, data: string) => unknown }, fills: unknown[]): void {
  if (fills.length > 0) server.publish(TOPIC, JSON.stringify({ type: "fills", data: fills }));
}
