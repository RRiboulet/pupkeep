// `web/` is plain browser JavaScript served without a build step, and
// `tsconfig.json` deliberately excludes it from the typecheck project. The
// TypeScript test `test/live-fallback.test.ts` imports the live transport, so
// this declaration beside the module gives it the three functions and the test
// seams it calls. Keep it in step with `live.js` if that public surface changes.

export interface LiveDeps {
  /** A test seam: the factory for one EventSource-like connection. */
  createSource?: (url: string) => unknown;
  refresh?: () => unknown;
  refreshUnread?: () => unknown;
  /** Timing seams; production passes none of them. */
  firstFrameMs?: number;
  silenceMs?: number;
  pollMs?: number;
  retryMs?: number;
}

export interface LiveHandle {
  close(): void;
}

/** Open the one stream and keep it live, polling when it stays silent. */
export function startLive(deps?: LiveDeps): LiveHandle;

/** Subscribe a screen to the shared thread's frames; returns an unsubscribe. */
export function subscribeThread(listener: (event: unknown) => void): () => void;

/** Whether the one live transport has fallen back to polling. */
export function isPolling(): boolean;

/** Apply a whole care view, never backwards; returns whether it was applied. */
export function applyCareView(view: unknown): boolean;

/** Read the care state once (used on every connect and by the fallback). */
export function refreshProfile(): Promise<void>;
