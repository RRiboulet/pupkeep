// The launcher redirects stdout/stderr into `~/.pupkeep/server.log` on the phone,
// which makes that file the one place a secret must never appear. Every line the
// app writes goes through `scrub()` first — the logger is the enforcement point,
// not each call site (PLAN §6.3, §14.4).
//
// Levels are deliberately few: this is a phone-hosted app whose log is read by one
// person after something went wrong.

import { scrub } from "../shared/redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  /** Where lines go. Default: stderr (the launcher already redirects it). */
  sink?: (line: string) => void;
  level?: LogLevel;
  /** Clock, injected so tests are deterministic. */
  now?: () => Date;
  /** Included on every line, e.g. "launcher". */
  scope?: string;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** A scoped child; the scope is appended to the parent's. */
  child(scope: string): Logger;
}

function formatFields(fields: Record<string, unknown> | undefined): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}=${rendered}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? ((line: string) => console.error(line));
  const level = options.level ?? "info";
  const now = options.now ?? (() => new Date());
  const scope = options.scope;

  function emit(at: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (ORDER[at] < ORDER[level]) return;
    const timestamp = now().toISOString();
    const prefix = scope ? ` [${scope}]` : "";
    // Scrub the message *and* the fields: a provider error can arrive through
    // either, and this is the last choke point before a file.
    const line = `${timestamp} ${at.toUpperCase()}${prefix} ${message}${formatFields(fields)}`;
    sink(scrub(line));
  }

  const logger: Logger = {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child(childScope: string) {
      return createLogger({
        sink,
        level,
        now,
        scope: scope ? `${scope}:${childScope}` : childScope,
      });
    },
  };
  return logger;
}
