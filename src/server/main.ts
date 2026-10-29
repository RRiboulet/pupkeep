// `bin/server.js`: parse the environment the launcher passes, start the app, and
// turn the app's end into a process exit code.
//
// The launcher owns the access mode and passes the resolved bind address; this
// file does not re-resolve it. The data directory is passed too, rather than
// re-derived, so the launcher's `--data` and the server's database cannot drift
// apart.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createLogger } from "./log.ts";
import { startApp, EXIT_BAD_CONFIG } from "./app.ts";

export interface ServerEnvironment {
  dataDir: string;
  host: string;
  port: number;
}

export type ParseServerEnvironment =
  | { ok: true; environment: ServerEnvironment }
  | { ok: false; error: string };

/** The launcher's contract: bind host + port + resolved data directory. */
export function parseServerEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): ParseServerEnvironment {
  const host = env.PUPKEEP_BIND_HOST;
  if (host === undefined || host === "") {
    return { ok: false, error: "PUPKEEP_BIND_HOST is not set; start the server through the launcher" };
  }
  if (/[\s/]/.test(host)) {
    return { ok: false, error: `PUPKEEP_BIND_HOST is not an address: ${host}` };
  }

  const rawPort = env.PUPKEEP_PORT;
  if (rawPort === undefined || rawPort === "") {
    return { ok: false, error: "PUPKEEP_PORT is not set; start the server through the launcher" };
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `PUPKEEP_PORT is not a port: ${rawPort}` };
  }

  const rawData = env.PUPKEEP_DATA_DIR;
  if (rawData === undefined || rawData === "") {
    return { ok: false, error: "PUPKEEP_DATA_DIR is not set; start the server through the launcher" };
  }
  const expanded = rawData === "~" ? home : rawData.startsWith("~/") ? join(home, rawData.slice(2)) : rawData;
  return {
    ok: true,
    environment: {
      host,
      port,
      dataDir: isAbsolute(expanded) ? resolve(expanded) : resolve(home, expanded),
    },
  };
}

/**
 * Run the server to completion. Returns the code the process should exit with:
 * 0 after a signal-initiated close, 1 after a storage failure or a close that
 * timed out, 2 for a bad environment, 5 for an open/bind failure. The caller is
 * `bin/server.js`; tests use `startApp` directly and never call this.
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const logger = createLogger({ scope: "server" });
  const parsed = parseServerEnvironment(env);
  if (!parsed.ok) {
    logger.error(parsed.error);
    return EXIT_BAD_CONFIG;
  }

  const result = await startApp(parsed.environment);
  if (!result.ok) {
    // startApp already logged the reason through the scrubbing logger; a second
    // line with the same text only makes the log harder to read.
    return result.code;
  }

  const app = result.app;
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      logger.info(`received ${signal}; closing`);
      void app.close();
    });
  }

  const end = await app.done;
  logger.info("stopped", { code: end.code, reason: end.reason });
  return end.code;
}

/** Entry for `bin/server.js`; keeps the error path in the scrubbing logger. */
export function runMain(env: NodeJS.ProcessEnv = process.env): void {
  const logger = createLogger({ scope: "server" });
  void main(env).then(
    (code) => process.exit(code),
    (error: unknown) => {
      logger.error("the server exited unexpectedly", { error });
      process.exit(1);
    },
  );
}
