/**
 * `bun:sqlite` over the SQLite a Durable Object carries. Wrangler points the `bun:sqlite`
 * specifier at this file (see the `alias` in wrangler.jsonc), so the same queries run on
 * both platforms; the four places the APIs differ are marked below.
 */

type Value = ArrayBuffer | string | number | null;

interface Cursor<T> {
  toArray(): T[];
  rowsWritten: number;
}

interface SqlStorage {
  exec<T extends Record<string, Value>>(query: string, ...bindings: unknown[]): Cursor<T>;
  databaseSize: number;
}

interface Storage {
  sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
}

let storage: Storage | undefined;

/** The object binds its storage here before importing anything that opens a database. */
export const use = (value: Storage): void => {
  storage = value;
};

export const bytesUsed = (): number => storage?.sql.databaseSize ?? 0;

const bound = (): Storage => {
  if (!storage) throw new Error("no durable object storage is bound; call use(ctx.storage) first");
  return storage;
};

/** Bun hands the driver Uint8Array and gets Uint8Array back; this storage speaks ArrayBuffer. */
const toBinding = (value: unknown): unknown => {
  if (value instanceof Uint8Array) {
    return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
      ? value.buffer
      : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
};

const fromRow = <T>(row: Record<string, Value>): T => {
  for (const key in row) {
    const value = row[key];
    if (value instanceof ArrayBuffer) (row as Record<string, unknown>)[key] = new Uint8Array(value);
  }
  return row as T;
};

/** The wide upserts bind by `$name`; this storage binds by position, so the names are read
 *  out of the text once, in the order they appear, and the object is spread over them. */
const NAMED = /\$[a-zA-Z_][a-zA-Z0-9_]*/g;

/** Statements are cached by the storage itself, so a query object is just the text. */
class Statement<T, P extends unknown[]> {
  private readonly text: string;
  private readonly names: string[];

  constructor(sql: string) {
    this.names = sql.match(NAMED) ?? [];
    this.text = this.names.length > 0 ? sql.replace(NAMED, "?") : sql;
  }

  /** Bun takes the names with or without their `$`; so does this. */
  private bindings(parameters: P): unknown[] {
    if (this.names.length === 0) return parameters.map(toBinding);
    const named = (parameters[0] ?? {}) as Record<string, unknown>;
    return this.names.map((name) => toBinding(named[name] ?? named[name.slice(1)] ?? null));
  }

  all(...parameters: P): T[] {
    return bound()
      .sql.exec(this.text, ...this.bindings(parameters))
      .toArray()
      .map((row) => fromRow<T>(row));
  }

  get(...parameters: P): T | null {
    return this.all(...parameters)[0] ?? null;
  }

  run(...parameters: P): { changes: number } {
    const cursor = bound().sql.exec(this.text, ...this.bindings(parameters));
    // The cursor counts rows only once it has been walked, and a write returns none.
    cursor.toArray();
    return { changes: cursor.rowsWritten };
  }
}

export class Database {
  /** The path is what a file-backed database needs; here the object already is the file.
   *  biome-ignore lint/complexity/noUselessConstructor: it stands in for the one bun:sqlite has. */
  constructor(_path?: string, _options?: { create?: boolean }) {}

  exec(sql: string): void {
    // A pragma tunes a file we do not own, and this storage errors on one rather than
    // ignoring it. Comments go first, so a semicolon inside one cannot split a statement.
    const statements = sql
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !/^pragma\b/i.test(part));
    for (const statement of statements) bound().sql.exec(statement);
  }

  query<T = unknown, P extends unknown[] = unknown[]>(sql: string): Statement<T, P> {
    return new Statement<T, P>(sql);
  }

  /** Bun returns a function to call; the object runs the closure in one storage transaction. */
  transaction<A extends unknown[]>(body: (...args: A) => void): (...args: A) => void {
    return (...args: A) => bound().transactionSync(() => body(...args));
  }

  close(): void {}
}
