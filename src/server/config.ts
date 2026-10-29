// The data directory. P1-05 owns the full version — `config.json`,
// `secrets.json`, `push.json`, serialized writes, the log scrub — but the
// launcher needs two things from it now: a directory that exists with the right
// mode, and the path of the owner link file.

import { chmod, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DATA_DIR_MODE = 0o700;

export interface DataDir {
  path: string;
  created: boolean;
  /** True when the mode had to be corrected; worth telling the owner once. */
  fixedMode: boolean;
}

/** Create the data directory if needed and make sure it is private. */
export async function ensureDataDir(path: string): Promise<DataDir> {
  const absolute = resolve(path);
  let created = false;
  try {
    await mkdir(absolute, { recursive: true, mode: DATA_DIR_MODE });
  } catch (error) {
    throw new Error(`cannot create the data directory ${absolute}: ${(error as Error).message}`);
  }

  const info = await stat(absolute);
  created = info.birthtimeMs === info.mtimeMs; // best effort; not used for decisions
  let fixedMode = false;
  if ((info.mode & 0o777) !== DATA_DIR_MODE) {
    // An existing directory may have been created by a loose umask; a data
    // directory holding secrets must not be world-readable.
    await chmod(absolute, DATA_DIR_MODE);
    fixedMode = true;
  }
  return { path: absolute, created, fixedMode };
}

export function ownerLinkPath(dataDir: string): string {
  return join(dataDir, "owner-link.txt");
}

export const OWNER_LINK_MODE = 0o600;
