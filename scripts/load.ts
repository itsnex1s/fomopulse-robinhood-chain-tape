/**
 * What a thousand readers actually do, done at once: hold a websocket, ask for the
 * status every 12 s and reload the tape every 30 s. Reports the percentiles of the
 * answers and how many fills the sockets received.
 *
 *   bun run scripts/load.ts http://localhost:8787 --readers 1000 --seconds 30
 *
 * Against a deployment this measures Cloudflare; against `wrangler dev` it measures
 * one laptop, which is the wrong number for capacity and the right one for finding out
 * whether the edge cache is doing its job (`x-cache` on every answer says which).
 */
export {};

const url = (process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:8787").replace(/\/$/, "");
const flag = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
};
const readers = flag("readers", 200);
const sockets = flag("sockets", Math.min(readers, 250));
const seconds = flag("seconds", 20);

const latencies: number[] = [];
let errors = 0;
let hits = 0;
let frames = 0;
let stop = false;

async function ask(path: string): Promise<void> {
  const started = performance.now();
  try {
    // A reader that waits ten seconds for the tape has already given up.
    const response = await fetch(url + path, { signal: AbortSignal.timeout(10_000) });
    await response.arrayBuffer();
    if (!response.ok) errors++;
    if (response.headers.get("x-cache") === "hit") hits++;
    latencies.push(performance.now() - started);
  } catch {
    errors++;
  }
}

/** One reader: the two polls the app makes, offset so they do not arrive in lockstep. */
async function reader(index: number): Promise<void> {
  await Bun.sleep((index * 37) % 12_000);
  while (!stop) {
    await ask("/api/status");
    if (index % 3 === 0) await ask("/api/tape?limit=400&window=24h&stocks=true&dust=false");
    await Bun.sleep(12_000);
  }
}

function listen(): void {
  const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws`);
  socket.onmessage = (event) => {
    if (String(event.data) !== "p") frames++;
  };
  const beat = setInterval(() => socket.readyState === 1 && socket.send("p"), 20_000);
  socket.onclose = () => clearInterval(beat);
}

console.log(`${readers} readers, ${sockets} sockets, ${seconds}s against ${url}`);
for (let i = 0; i < sockets; i++) listen();
const running = Array.from({ length: readers }, (_, i) => reader(i));
await Bun.sleep(seconds * 1_000);
stop = true;
await Promise.all(running);

latencies.sort((a, b) => a - b);
const at = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))]?.toFixed(0);
console.log(
  `${latencies.length} requests, ${errors} failed, ${hits} from cache · ` +
    `p50 ${at(0.5)}ms · p95 ${at(0.95)}ms · p99 ${at(0.99)}ms · ${frames} fill frames over ${sockets} sockets`,
);
// The sockets are still open and would hold the loop for as long as they live.
process.exit(0);
