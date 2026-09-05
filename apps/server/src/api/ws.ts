import type { ServerWebSocket } from "bun";

const TOPIC = "fills";

/** Clients keep the socket alive with a bare "p" every 20 s, as the original does. */
export const websocket = {
  open(ws: ServerWebSocket<undefined>) {
    ws.subscribe(TOPIC);
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
