// Fanning the shared thread's Pi Durable events out to every connected browser.
//
// PLAN §9.4: the server attaches `watchEvents` to the shared conversation; on
// attach **and** on reconnect each client first receives a full snapshot, then
// deltas (serialized Pi Durable events). The long-poll fallback returns full
// snapshots too, never deltas. Only this one conversation's stream is attached,
// so another conversation's events cannot reach a subscriber here.
//
// Connections are capped per member (§9.4): a cap breach drops the member's
// *oldest* connection politely — one at a time, with a `reconnect` notice —
// rather than refusing the new browser or dropping everything at once.

import type { Context } from "@earendil-works/chord";
import { watchEvents, type AgentEvent, type AgentEventStream, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { THREAD_CONNECTIONS_PER_USER } from "../../shared/chat.ts";
import type { PuppyProfile } from "../../shared/profile.ts";

export type Notice = "snapshot" | "batch" | "reconnect";

export interface Subscriber {
  /** Frame one SSE event or resolve one long-poll turn; must not throw. */
  readonly notice: (type: Notice, events?: readonly AgentEvent[]) => void;
  /**
   * One committed state change (the puppy profile today). Optional so a
   * diagnostics-only subscriber need not implement it; a throwing one is
   * evicted exactly like a broken `notice`.
   */
  readonly state?: (frame: StateFrame) => void;
  readonly onClose: () => void;
}

/**
 * A state frame is the answer to "the care state changed", not a thread delta:
 * it carries the whole view so a client never has to merge two partial
 * updates. P2's feeding and walk views ride this same frame.
 */
export type StateFrame = {
  readonly kind: "profile";
  readonly profile: PuppyProfile;
};

interface Connection {
  readonly id: number;
  readonly userId: string;
  readonly subscriber: Subscriber;
  /** Dropped when the per-user cap evicts this connection. */
  evicted: boolean;
}

interface Waiter {
  readonly since: number;
  readonly settle: (result: "changed" | "timeout" | "closed") => void;
  /** Set once no matter the outcome, so a re-settle cannot double-act. */
  finished: boolean;
}

export interface ThreadBusOptions {
  readonly harness: Harness;
  /** The human-facing conversation; nothing else is ever attached. */
  readonly conversationId: number;
  readonly context: Context;
  /** Kept-unref'd timers default; tests inject a fake one. */
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout | undefined;
  /** The stream ended by itself; logs only, never a credential. */
  onEnded?: (message: string) => void;
}

export class ThreadBus {
  readonly #options: ThreadBusOptions;
  readonly #conversationId: number;
  #seq = 0;
  #nextId = 1;
  #connections: Connection[] = [];
  #waiters: Waiter[] = [];
  #stream: AgentEventStream | undefined;
  #closed = false;

  constructor(options: ThreadBusOptions) {
    this.#options = options;
    this.#conversationId = options.conversationId;
  }

  /** Current event counter; every snapshot and poll answer answers with it. */
  get seq(): number {
    return this.#seq;
  }

  /** Diagnostics for tests: settled waiters must not accumulate. */
  get waiterCount(): number {
    return this.#waiters.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Attach to the shared conversation. The stream's own snapshot is folded into
   * the seq bump; clients attached later are caught up by their initial HTTP
   * snapshot, never by stale deltas.
   */
  async start(): Promise<void> {
    this.#stream = await watchEvents(this.#options.harness, this.#conversationId as ConversationId, this.#options.context);
    this.#stream.start(async (events) => {
      if (events.length === 0) return;
      this.#broadcast(events);
    });
    void this.#stream.closed.then((end) => {
      // The Session failed (or the harness stopped the stream): mark the client.
      // They reattach with a fresh snapshot instead of believing a dead thread.
      if (!this.#closed) {
        this.#options.onEnded?.(errorText(end));
        this.stop();
      }
    });
  }

  /** Stop the Pi Durable stream and tell subscribers to reconnect. */
  stop(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stream?.stop().catch(() => undefined);
    for (const connection of [...this.#connections]) {
      connection.evicted = true;
      connection.subscriber.notice("reconnect");
    }
    this.#connections = [];
    for (const waiter of [...this.#waiters]) this.#settleWaiter(waiter, "closed");
    this.#waiters = [];
  }

  /**
   * Publish one state frame to every attached browser. This does not bump `seq`:
   * the counter belongs to the thread stream, and a state change must not make a
   * long-poll client believe there is new conversation to read.
   */
  publishState(frame: StateFrame): void {
    if (this.#closed) return;
    for (const connection of [...this.#connections]) {
      if (connection.evicted) continue;
      try {
        connection.subscriber.state?.(frame);
      } catch {
        connection.evicted = true;
      }
    }
  }

  #broadcast(events: readonly AgentEvent[]): void {
    if (this.#closed) return;
    this.#seq += 1;
    for (const connection of [...this.#connections]) {
      if (connection.evicted) continue;
      try {
        connection.subscriber.notice("batch", events);
      } catch {
        // One broken socket must not abort the fan-out for every other
        // connection; evict it and let its close handler clean up.
        connection.evicted = true;
      }
    }
    for (const waiter of [...this.#waiters]) {
      if (this.#seq > waiter.since) this.#settleWaiter(waiter, "changed");
    }
  }

  /** Settle with bookkeeping; the waiter's own timer is cleared in `poll`. */
  #settleWaiter(waiter: Waiter, result: "changed" | "closed"): void {
    this.#waiters = this.#waiters.filter((entry) => entry !== waiter);
    waiter.settle(result);
  }

  /**
   * Subscribe one browser socket. Returns its unsubscribe; the *order* matters
   * for the cap rule, because entries push oldest first. Once the Pi Durable
   * stream has ended, a subscription is refused with a `reconnect` notice
   * instead of a heartbeating connection that can never carry a delta.
   */
  subscribe(userId: string, subscriber: Subscriber): () => void {
    if (this.#closed) {
      subscriber.notice("reconnect");
      return () => undefined;
    }
    const userConnections = this.#connections.filter((connection) => connection.userId === userId);
    if (userConnections.length >= THREAD_CONNECTIONS_PER_USER) {
      for (const stale of userConnections) {
        if (stale.evicted) continue;
        stale.evicted = true;
        stale.subscriber.notice("reconnect");
        break; // drop slowly: one polite close per new connection
      }
      this.#connections = this.#connections.filter((connection) => !connection.evicted);
    }
    const connection: Connection = {
      id: this.#nextId++,
      userId,
      subscriber,
      evicted: false,
    };
    this.#connections.push(connection);
    return () => {
      this.#connections = this.#connections.filter((candidate) => candidate !== connection);
      subscriber.onClose();
    };
  }

  /**
   * Long-poll: resolve once a broadcast lands after `since`, the wait elapses,
   * or the thread stops. The caller answers with a full snapshot in every case
   * (§9.4: the fallback never sends only deltas).
   *
   * The wait holds one connection slot like an SSE connection does; eviction
   * settles it as `closed`, so a stale poll never waits out its clock.
   */
  poll(userId: string, since: number, timeoutMs: number): Promise<"changed" | "timeout" | "closed"> {
    if (this.#closed) return Promise.resolve("closed");
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: Waiter = {
        since,
        finished: false,
        settle: (result) => {
          if (waiter.finished) return;
          waiter.finished = true;
          // Every settle path (change, closed, timeout) disarms the wait: an
          // unref'd timer left behind is still a handle per expired poll.
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          // Leave on any settle, whatever the path: a long stream of expired
          // polls must never grow this list.
          this.#waiters = this.#waiters.filter((entry) => entry !== waiter);
          unsubscribe();
          resolve(result);
        },
      };
      let unsubscribe = (): void => undefined;

      // The poll's slot: the same per-user cap governs the fallback.
      const subscriber: Subscriber = {
        notice: (type) => {
          if (type === "reconnect") waiter.settle("closed");
        },
        onClose: () => waiter.settle("closed"),
      };
      unsubscribe = this.subscribe(userId, subscriber);

      // A poll evicted during subscribe was already settled and removed;
      // pushing it afterwards would leak, so only a live waiter is tracked.
      // The eviction's settle ran while `unsubscribe` was still the no-op
      // placeholder, so remove the connection it just created as well.
      if (waiter.finished) unsubscribe();
      if (!waiter.finished) {
        const arm = this.#options.setTimer
          ?? ((callback: () => void, ms: number) => {
            const handle = setTimeout(callback, ms);
            handle.unref?.();
            return handle;
          });
        timer = arm(() => waiter.settle("timeout"), Math.max(0, timeoutMs));
        // A synchronous timer may already have settled; do not track it then.
        if (waiter.finished) {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          return;
        }
        this.#waiters.push(waiter);
        if (this.#seq > since) waiter.settle("changed");
      }
    });
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === "" ? "the thread stream ended" : message.slice(0, 200);
}
