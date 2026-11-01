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
