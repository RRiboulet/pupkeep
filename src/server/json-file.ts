// The one safe way to write a JSON file in the data directory.
//
// PLAN §7.1 is specific about why: a temp file + `fsync(temp)` + `rename` +
// `fsync(dir)` makes a *replacement* atomic, but atomic rename is not mutual
// exclusion. Two read-modify-write cycles can each read the same old value and one
// silently loses the other's change — which for `config.json` means an invite that
// vanished or a session that came back from the dead. So every file has exactly
// one write queue, and a store for the same path shares it.

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export class JsonFileError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${message}: ${path}`);
    this.name = "JsonFileError";
    this.path = path;
  }
}

/**
 * One queue per absolute path, shared by every store instance in the process. A
 * second `JsonFileStore` for the same file must not get a second queue.
 */
const queues = new Map<string, Promise<unknown>>();

/** Test hook: wait until no write is in flight for a path (or for all paths). */
export async function whenIdle(path?: string): Promise<void> {
  if (path) {
    await (queues.get(resolve(path)) ?? Promise.resolve());
    return;
  }
  await Promise.allSettled([...queues.values()]);
}

async function fsyncDirectory(directory: string): Promise<void> {
  // Renaming is only durable once the directory entry is flushed. Opening a
  // directory read-only works on Linux/Android; on platforms where it does not,
  // the rename still happened, so this is best-effort rather than fatal.
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // EISDIR/EPERM/EINVAL: the data is on disk, the directory flush is not
    // supported here. Not a reason to fail a write that already succeeded.
  }
}

export interface AtomicWriteOptions {
  mode?: number;
}

/** Replace a file atomically, fsyncing the file and its directory. */
export async function atomicWrite(
  path: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const absolute = resolve(path);
  const directory = dirname(absolute);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  // Same-directory temp file, so the rename cannot cross a filesystem boundary.
  const temporary = `${absolute}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const handle = await open(temporary, "wx", options.mode ?? 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, absolute);
  } catch (error) {
    await rm(temporary, { force: true });
    throw new JsonFileError(absolute, `could not replace the file (${(error as Error).message})`);
  }
  await fsyncDirectory(directory);
}

export interface JsonFileOptions<T> {
  path: string;
  mode?: number;
  /** Validate and normalise on read. Returning undefined means "unusable". */
  parse: (raw: unknown) => T | undefined;
  /** Value for a file that does not exist yet. */
  initial: () => T;
}

export class JsonFileStore<T> {
  readonly #options: JsonFileOptions<T>;
  readonly path: string;

  constructor(options: JsonFileOptions<T>) {
    this.#options = options;
    this.path = resolve(options.path);
  }

  /** Read the current value. An unreadable or invalid file is an error, not a default. */
  async read(): Promise<T> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.#options.initial();
      throw new JsonFileError(this.path, `could not read (${(error as Error).message})`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      // Refusing to guess is the safer failure: a half-written or hand-edited
      // config must be reported, not silently replaced with defaults that drop
      // every invite.
      throw new JsonFileError(this.path, `is not valid JSON (${(error as Error).message})`);
    }
    const parsed = this.#options.parse(raw);
    if (parsed === undefined) {
      throw new JsonFileError(this.path, "does not match the expected shape (schemaVersion?)");
    }
    return parsed;
  }

  /**
   * Read-modify-write under this file's single queue. The mutator receives the
   * current value and returns the next one; it may be called only once per update.
   */
  async update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const current = await this.read();
      const next = await mutator(current);
      await atomicWrite(this.path, `${JSON.stringify(next, null, 2)}\n`, {
        mode: this.#options.mode ?? 0o600,
      });
      return next;
    };

    const previous = queues.get(this.path) ?? Promise.resolve();
    // Chain unconditionally: a failed write must not stop later writes, but it
    // must not be swallowed for its own caller either.
    const next = previous.then(run, run);
    queues.set(
      this.path,
      next.catch(() => undefined),
    );
    return next;
  }
}
