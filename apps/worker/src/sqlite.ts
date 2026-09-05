/**
 * `bun:sqlite` over the SQLite a Durable Object carries.
 *
 * The tape has one set of queries; this is what lets both platforms run them. Wrangler
 * points `bun:sqlite` at this file (see the `alias` in wrangler.jsonc), so `db.ts` opens
 * a Database exactly as it does under Bun and never learns where it lives. The two APIs
 * differ in four places, all handled here: the object's storage is bound to this module
 * before the app is imported, blobs cross as ArrayBuffer and come back as Uint8Array,
 * `$name` bindings are lifted into positions because this storage only counts, and the
 * pragmas that tune a file on disk have no meaning on storage the platform manages, so
 * they are dropped.
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
    // A pragma tunes a file we do not own — journal mode, synchronous, busy timeout are
    // the platform's business — and running one here is an error rather than a no-op.
    // Comments go first: the schema documents its columns, and a comment carrying a
    // semicolon would otherwise cut a statement in half.
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
