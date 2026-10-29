// The owner sign-in link is the trust root: whoever has it can take the household
// over, and `--reissue-owner` exists precisely because it is the one credential a
// lost phone cannot recover from inside the app.
//
// So (PLAN §6.3): it is written to `~/.pupkeep/owner-link.txt` at 0600 **only**
// when a token is minted or reissued, and a boot never logs it — a boot logs the
// path. This module is the only place that knows that rule.

import { writeFile } from "node:fs/promises";
import { OWNER_LINK_MODE } from "../server/config.ts";

export interface AnnounceOptions {
  /** The full sign-in URL, token included. */
  link: string;
  /** Where to write it, at 0600. */
  path: string;
  /** False for boot/non-interactive: write the file, log the path, print nothing. */
  interactive: boolean;
  writeFile: boolean;
  /** Where human-facing text goes. Default `process.stdout.write`. */
  writeOut?: (text: string) => void;
  /** Where the log line goes. Default `console.error`. */
  log?: (line: string) => void;
}

export interface AnnounceResult {
  written: boolean;
  printed: boolean;
}

/** `https://…/login?token=abc` → `https://…/login?token=…` */
export function redactLink(link: string): string {
  return link.replace(/([?&](?:token|key|code|invite)=)[^\s&#]+/gi, "$1[redacted]");
}

export async function announceOwnerLink(options: AnnounceOptions): Promise<AnnounceResult> {
  const writeOut = options.writeOut ?? ((text: string) => process.stdout.write(text));
  const log = options.log ?? ((line: string) => console.error(line));

  let written = false;
  if (options.writeFile) {
    // Newline-terminated on purpose: `cat` and copy-paste both behave, and the
    // 0600 mode means only this account can read it back.
    await writeFile(options.path, `${options.link}\n`, { mode: OWNER_LINK_MODE, encoding: "utf8" });
    written = true;
  }

  if (options.interactive) {
    writeOut(
      [
        "",
        "  Owner sign-in link — this is the only credential that can take over the household.",
        "",
        `  ${options.link}`,
        "",
        written ? `  Also written to ${options.path} (0600).` : "",
        "  Open it on this device, then create a one-time invite for the other caregiver.",
        "",
      ]
        .filter((line) => line !== "")
        .join("\n") + "\n",
    );
    return { written, printed: true };
  }

  // Boot: the link must not reach a log that the operator may paste somewhere.
  log(
    written
      ? `owner link written to ${options.path} (0600); not printed in boot mode (${redactLink(options.link)})`
      : `owner link available; not printed in boot mode (${redactLink(options.link)})`,
  );
  return { written, printed: false };
}
