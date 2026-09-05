/**
 * Re-render the icons and the share card from `apps/web/og/*.html`.
 * Headless Chrome is the renderer because the card is a normal page: same fonts, same
 * palette, same table as the app, and no image editor in the loop.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CANDIDATES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter((path): path is string => !!path);
const CHROME = CANDIDATES.find((path) => existsSync(path));
if (!CHROME) throw new Error("no Chrome found; set CHROME to the browser binary");

// `fileURLToPath`, not `.pathname`: on Windows the latter is `/D:/…`, which neither Chrome nor Bun opens.
const og = fileURLToPath(new URL("../apps/web/og/", import.meta.url));
const out = fileURLToPath(new URL("../apps/web/public/", import.meta.url));

// A small window is clamped to the platform minimum and the icon slides out of the
// shot, so the icons render at 512 and Chrome scales the screenshot down itself.
const ICON_VIEWPORT = 512;
const shots: [page: string, file: string, width: number, height: number, scale: number][] = [
  ["og.html", "og.png", 1200, 630, 1],
  ["icon.html", "icon-180.png", ICON_VIEWPORT, ICON_VIEWPORT, 180 / ICON_VIEWPORT],
  ["icon.html", "icon-192.png", ICON_VIEWPORT, ICON_VIEWPORT, 192 / ICON_VIEWPORT],
  ["icon.html", "icon-512.png", ICON_VIEWPORT, ICON_VIEWPORT, 1],
];

// Screenshots must not touch the browser you have open: its singleton would take the
// flags as navigation orders instead.
const profile = `${tmpdir()}/fomopulse-shots`.replace(/\\/g, "/");

/**
 * The wallet count on the card comes from the roster the card is about. It read 236 while
 * the roster held 294 — a number kept by hand in the markup is wrong again the next time
 * `roster.ts` runs, and nothing about the card says so. The file on disk keeps the last
 * rendered count, so opening it in a browser still shows a card.
 */
const roster = (JSON.parse(await Bun.file(`${og}../../../config/wallets.json`).text()) as unknown[]).length;
const staged = `${tmpdir()}/fomopulse-og.html`.replace(/\\/g, "/");
await Bun.write(
  staged,
  (await Bun.file(`${og}og.html`).text()).replace(/(<b id="wallets">)\d+(<\/b>)/, `$1${roster}$2`),
);

for (const [page, file, width, height, scale] of shots) {
  // The old file goes first, so `exists` below is a real check. Chrome fails often enough
  // for one reason or another — a stale profile lock is the usual one — and leaving the
  // last render in place means a card that says whatever it said before, silently.
  await Bun.file(`${out}${file}`)
    .delete()
    .catch(() => {});
  const proc = Bun.spawnSync([
    CHROME,
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${scale}`,
    `--screenshot=${out}${file}`,
    `file://${page === "og.html" ? staged : og + page}`,
  ]);
  if (!(await Bun.file(out + file).exists())) {
    throw new Error(`${file} was not written: ${proc.stderr.toString().trim().split("\n").pop()}`);
  }
  console.log(`${file} ${Math.round(width * scale)}×${Math.round(height * scale)}`);
}

// iOS looks for this name whether or not the page links to it.
await Bun.write(`${out}apple-touch-icon.png`, Bun.file(`${out}icon-180.png`));
console.log("apple-touch-icon.png 180×180");
