// `npm run restore -- [options]` — restore one encrypted bundle with the server
// stopped (PLAN §7.5). The core refuses while a live launcher/server lock is
// present, removes stale WAL/SHM files, and leaves `secrets.json` alone: the
// bundle excludes provider keys deliberately, so the operator re-enters them
// rather than recovering them from a backup.
//
// A restore is not a merge. Without `--force` it refuses a data directory that
// already has a database/config/push; with `--force` it moves those aside into
// `restore-backup-<timestamp>/` first, so a mistaken restore is recoverable.

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  checkBackupTools,
  DEFAULT_PASSPHRASE_ENV,
  newestArchive,
  readPassphrase,
  restoreDataDir,
  runCommand,
} from "../src/server/backup.ts";
import { absolutePath, booleanValue, stringValue } from "../src/server/cli.ts";
import { createLogger } from "../src/server/log.ts";

const USAGE = `pupkeep restore — replace a data directory from an encrypted backup

Usage: npm run restore -- [options]

  --data <dir>                 data directory (default: ~/.pupkeep)
  --archive <file.age>         archive to restore (default: newest in <data>/backups)
  --passphrase-env <name>      default ${DEFAULT_PASSPHRASE_ENV}
  --passphrase-file <path>     must be outside the data and backup directories
  --force                      move an existing database/config/push aside first
  -h, --help                   show this help

The server must be stopped: a live launcher.pid or server.pid is refused.
secrets.json is not in the bundle; provider keys are re-entered.
`;

export interface RestoreCliOptions {
  dataDir: string;
  archive?: string;
  passphraseEnv: string;
  passphraseFile?: string;
  force: boolean;
  help: boolean;
}

export function parseRestoreArgs(argv: readonly string[], home: string = homedir()): RestoreCliOptions {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      data: { type: "string" },
      archive: { type: "string" },
      "passphrase-env": { type: "string" },
      "passphrase-file": { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const archive = stringValue(values.archive, "--archive");
  const passphraseFile = stringValue(values["passphrase-file"], "--passphrase-file");
  return {
    dataDir: absolutePath(stringValue(values.data, "--data") ?? "~/.pupkeep", home),
    ...(archive !== undefined ? { archive: absolutePath(archive, home) } : {}),
    passphraseEnv: stringValue(values["passphrase-env"], "--passphrase-env") ?? DEFAULT_PASSPHRASE_ENV,
    ...(passphraseFile !== undefined ? { passphraseFile: absolutePath(passphraseFile, home) } : {}),
    force: booleanValue(values.force, "--force"),
    help: booleanValue(values.help, "--help"),
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  process.umask(0o077);
  const logger = createLogger({ scope: "restore" });
  let options: RestoreCliOptions;
  try {
    options = parseRestoreArgs(argv);
  } catch (error) {
    logger.error(`restore: ${(error as Error).message}`);
    process.stderr.write(USAGE);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    const backupDir = join(options.dataDir, "backups");
    const archive =
      options.archive ?? (await newestArchive(backupDir));
    if (!archive) {
      throw new Error(`no archive given and no backup archives in ${backupDir}`);
    }

    const passphrase = await readPassphrase({
      dataDir: options.dataDir,
      backupDir,
      envName: options.passphraseEnv,
      ...(options.passphraseFile !== undefined ? { file: options.passphraseFile } : {}),
    });
    await checkBackupTools(runCommand, false);
    const result = await restoreDataDir({
      archive,
      dataDir: options.dataDir,
      passphrase,
      force: options.force,
    });

    process.stdout.write(`restored ${result.restored.join(", ")} from ${archive} (durable seq ${result.seq})\n`);
    if (result.movedAside) {
      process.stdout.write(`the previous files were moved to ${result.movedAside}\n`);
    }
    if (!result.secretsPresent) {
      process.stdout.write(
        "secrets.json is absent (it is excluded from backups); re-enter the provider keys before use.\n",
      );
    } else {
      process.stdout.write("secrets.json was left in place; its provider keys were not part of the bundle.\n");
    }
    return 0;
  } catch (error) {
    logger.error((error as Error).message);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
