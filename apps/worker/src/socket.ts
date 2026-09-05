/**
 * A client websocket, the way this platform makes one. There is no `new WebSocket(url)`
 * here: a Worker asks the other end for an upgrade and takes the socket off the
 * response. The subscription code holds its socket from the first line and assigns its
 * handlers immediately, so this stands in until the upgrade answers — handlers are kept
 * and wired to the real socket, and anything sent in the meantime is queued.
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
