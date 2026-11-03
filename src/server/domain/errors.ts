// Domain-level refusals the HTTP layer maps to one status.
//
// `src/server/auth.ts` owns `Refusal` for credential-shaped answers (401/403/
// 409/429). These are the *domain* answers — "the profile document is not
// readable", "this revision is not the current one" — and they carry a status
// for the same one-mapper rule in `src/server/http.ts`. Nothing throws a stack
// trace at a caregiver.

/** The server is not ready for this request; retry after boot/repair. */
export class UnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = "UnavailableError";
  }
}

/** The request is well-formed JSON but the domain refuses it (409). */
export class DomainConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "DomainConflictError";
  }
}

/**
 * The revision the caller read is no longer the current one (§7.4). A private
 * control-flow signal inside the domain — the callers turn it into a 409 with
 * the current view — so it is not a `Refusal` with a caregiver-facing message.
 */
export class StaleRevisionError extends Error {
  constructor(message = "the record changed since it was read") {
    super(message);
    this.name = "StaleRevisionError";
  }
}
