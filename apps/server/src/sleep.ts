/** `Bun.sleep` only exists under Bun, and the same ingest runs inside a Worker. */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
