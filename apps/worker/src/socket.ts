/**
 * A client websocket, the way this platform makes one: there is no `new WebSocket(url)` in
 * a Worker, only a fetch that asks for an upgrade and a socket taken off the response. The
 * stub stands in until that answers, keeping the handlers and queueing what is sent.
 */
import { log } from "../../server/src/log.ts";

export function upgrade(url: string): WebSocket {
  const queue: string[] = [];
  let live: WebSocket | undefined;
  let closed = false;

  const stub = {
    onopen: null as ((event: unknown) => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    onclose: null as ((event: { code: number }) => void) | null,
    send(data: string) {
      if (live) live.send(data);
      else queue.push(data);
    },
    close() {
      closed = true;
      live?.close();
    },
  };

  fetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } })
    .then((response) => {
      const socket = response.webSocket;
      if (!socket) throw new Error(`the endpoint answered ${response.status} instead of an upgrade`);
      socket.accept();
      if (closed) {
        socket.close();
        return;
      }
      live = socket;
      socket.addEventListener("message", (event) => stub.onmessage?.({ data: event.data }));
      socket.addEventListener("error", () => stub.onerror?.({}));
      socket.addEventListener("close", (event) => stub.onclose?.({ code: event.code }));
      for (const message of queue.splice(0)) socket.send(message);
      // An accepted socket is already open; the caller is told the same way it would be.
      stub.onopen?.({});
    })
    .catch((error) => {
      stub.onerror?.({});
      stub.onclose?.({ code: 1006 });
      log.error("upgrade failed", error);
    });

  return stub as unknown as WebSocket;
}
