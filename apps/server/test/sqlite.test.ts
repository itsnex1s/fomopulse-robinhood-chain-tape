import { expect, test } from "bun:test";
import { Database, use } from "../../worker/src/sqlite.ts";

/** Storage that records what it was asked, standing in for the object's SQLite. */
function fakeStorage() {
  const calls: { query: string; bindings: unknown[] }[] = [];
  return {
    calls,
    sql: {
      databaseSize: 0,
      exec(query: string, ...bindings: unknown[]) {
        calls.push({ query, bindings });
        return { toArray: () => [], rowsWritten: 1 };
      },
    },
    transactionSync: <T>(closure: () => T) => closure(),
  };
}

test("named parameters are bound in the order the text names them", () => {
  const storage = fakeStorage();
  use(storage);
  const database = new Database();
  database
    .query("INSERT INTO prices (token, price_usd, change1h) VALUES ($token, $price, $change1h)")
    .run({ $token: "0xabc", price: 1.5, $change1h: null });

  const call = storage.calls[0];
  expect(call?.query).toBe("INSERT INTO prices (token, price_usd, change1h) VALUES (?, ?, ?)");
  // The name may come with its `$` or without, the way bun:sqlite takes it; what is missing is null.
  expect(call?.bindings).toEqual(["0xabc", 1.5, null]);
});

test("positional parameters and blobs cross unchanged", () => {
  const storage = fakeStorage();
  use(storage);
  new Database().query("SELECT * FROM fills WHERE tx = ? AND block > ?").all(new Uint8Array([1, 2]), 7);

  const call = storage.calls[0];
  expect(call?.query).toBe("SELECT * FROM fills WHERE tx = ? AND block > ?");
  expect(call?.bindings[0]).toBeInstanceOf(ArrayBuffer);
  expect(call?.bindings[1]).toBe(7);
});

test("the schema is split into statements and its pragmas dropped", () => {
  const storage = fakeStorage();
  use(storage);
  new Database().exec("PRAGMA journal_mode = WAL;\n/* the fills */\nCREATE TABLE a (b TEXT);\n");

  expect(storage.calls.map((call) => call.query.trim())).toEqual(["CREATE TABLE a (b TEXT)"]);
});
