// Small argument helpers shared by the backup and restore CLIs.
//
// They live here rather than in either script because the two copies drifted:
// `--passphrase-file` was expanded in one shape and the archive path in another,
// and a `~/secret` that reached `readPassphrase` literally resolved under the
// current directory. One implementation keeps `~`, `--data` and a passphrase
// file consistent, and gives the scripts one place to fix path behaviour.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** `~`, `~/x` and a plain path, without pulling in a shell. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** Expand and resolve a CLI path against the user's home, never the process cwd. */
export function absolutePath(path: string, home: string = homedir()): string {
  return resolve(home, expandHome(path, home));
}

/** A single string option; `node:util.parseArgs` gives arrays for repeats. */
export function stringValue(value: unknown, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw new Error(`${flag} may be given only once`);
  if (typeof value !== "string") throw new Error(`${flag} needs a value`);
  return value;
}

/** A boolean flag; `parseArgs` sets true, and anything else is a usage error. */
export function booleanValue(value: unknown, flag: string): boolean {
  if (value === undefined) return false;
  if (value === true) return true;
  throw new Error(`${flag} does not take a value`);
}
