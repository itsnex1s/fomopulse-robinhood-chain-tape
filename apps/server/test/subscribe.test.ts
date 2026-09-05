import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { watch } from "../src/ingest/subscribe.ts";

/** A node that accepts subscriptions and, optionally, stops answering the heartbeat. */
function fakeNode(answerHeartbeat: boolean) {
  const sockets = new Set<ServerWebSocket<undefined>>();
  const server = Bun.serve<undefined>({
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("expected a websocket", { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      message(ws, raw) {
        const m = JSON.parse(String(raw)) as { id: number; method: string };
        if (m.method === "eth_subscribe") ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: `0xsub${m.id}` }));
        else if (m.method === "eth_blockNumber" && answerHeartbeat)
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: "0x10" }));
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  return {
    url: `ws://localhost:${server.port}`,
    push(subscription: string, result: unknown) {
      for (const ws of sockets)
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription, result } }));
    },
    stop: () => server.stop(true),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("logs arrive through the subscription and a stop is silent", async () => {
  const node = fakeNode(true);
  const logs: unknown[] = [];
  let down: string | undefined;
  const stop = watch(
    node.url,
    (log) => logs.push(log),
    (why) => (down = why),
    { heartbeatMs: 20, timeoutMs: 100 },
  );
  await sleep(100);
  node.push("0xsub1", { transactionHash: "0xabc", blockNumber: "0x10", logIndex: "0x2" });
  node.push("0xnobody", { transactionHash: "0xdef", blockNumber: "0x11", logIndex: "0x0" }); // not ours
  await sleep(50);
  expect(logs).toEqual([{ transactionHash: "0xabc", blockNumber: 16n, logIndex: 2, removed: false }]);
  stop();
  await sleep(50);
  expect(down).toBeUndefined();
  node.stop();
});

test("a socket that stops answering the heartbeat is declared down once", async () => {
  const node = fakeNode(false);
  const reasons: string[] = [];
  watch(
    node.url,
    () => {},
    (why) => reasons.push(why),
    { heartbeatMs: 20, timeoutMs: 40 },
  );
  await sleep(250);
  expect(reasons).toEqual(["heartbeat timed out"]);
  node.stop();
});

test("a closed socket is declared down", async () => {
  const node = fakeNode(true);
  const reasons: string[] = [];
  watch(
    node.url,
    () => {},
    (why) => reasons.push(why),
    { heartbeatMs: 1_000, timeoutMs: 1_000 },
  );
  await sleep(50);
  node.stop();
  await sleep(100);
  expect(reasons).toHaveLength(1);
  expect(reasons[0]).toStartWith("socket closed");
});
