/**
 * Everything a human reads goes to stderr. stdout is the tape itself, so
 * `bun run ingest --once > fills.txt` stays clean.
 */
const stamp = () => new Date().toISOString().slice(11, 19);
const write = (level: string, message: string) => console.error(`${stamp()} ${level.padEnd(5)} ${message}`);

/** The first line of an error, which is the one that says what happened. */
export const describe = (error: unknown): string =>
  error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);

export const log = {
  info: (message: string) => write("info", message),
  warn: (message: string) => write("warn", message),
  error: (message: string, error?: unknown) =>
    write("error", error === undefined ? message : `${message}: ${describe(error)}`),
};
