// The shower card (PLAN §13.1, §16 P3-07).
//
// One primary action logs a shower. The card then reports state: the last
// shower, the next due date in household-local terms, and the recent few from
// the history. It never coaches — no advice, no "should have" copy.
//
// The rules this component shares with the other care surfaces:
//   * the history is read from `GET /api/showers` (the care frame is a signal,
//     not data: P2-05). The parent (`views/pup.js`) owns that read and passes the
//     committed view down;
//   * a write's answer is bounded (the history is unbounded), so after a
//     successful log this card asks the parent to re-read the history instead of
//     adopting a collection from the answer;
//   * an action's idempotency key is held with the body it belongs to
//     (`pendingSave`): a lost response retried with the same text replays
//     instead of logging a second shower;
//   * a refusal shows the one mapper's sentence (`{ error }`), never a stack;
//   * the status region is `role="status"`, so the result is announced.

import { Component, h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { NetworkError, requestJson } from "../client.js";
import { dateText } from "../clock.js";
import { pendingSave } from "../profile-form.js";
import {
  NOTES_MAX,
  SHAMPOO_MAX,
  dueText,
  earlierCount,
  intervalText,
  lastShowerText,
  recentShowers,
  showerBody,
  showerMetaText,
} from "../showers.js";

const html = htm.bind(h);

const EMPTY_DRAFT = { shampoo: "", notes: "" };

export class Showers extends Component {
  constructor(props) {
    super(props);
    // The test seam the other views use: production passes nothing.
    this.request = props?.request ?? requestJson;
  }

  state = { draft: EMPTY_DRAFT, busy: false, error: null, message: null, pending: null };

  onInput = (event) => {
    const { name, value } = event.target;
    this.setState({ draft: { ...this.state.draft, [name]: value }, message: null });
  };

  /**
   * Log one shower. The key stays with the body (P1-11's rule); a shower has no
   * revision, so there is no stale answer to handle — a refusal is the domain's
   * own sentence and nothing is written.
   */
  async save(event) {
    event.preventDefault();
    if (this.state.busy) return;
    const body = showerBody(this.state.draft);
    const pending = pendingSave(this.state.pending, body);
    this.setState({ busy: true, error: null, message: null, pending });
    try {
      const result = await this.request("/api/showers", {
        method: "POST",
        body,
        idempotencyKey: pending.key,
      });
      if (result.status === 401) {
        this.setState({ busy: false, error: "Please sign in again." });
        return;
      }
      if (!result.ok) {
        this.setState({
          busy: false,
          error: result.body?.error ?? result.body?.message ?? "Could not log the shower. Try again.",
        });
        return;
      }
      this.setState({
        busy: false,
        draft: EMPTY_DRAFT,
        pending: null,
        error: null,
        message: result.body?.replayed ? "Already logged." : "Logged.",
      });
      // The history is unbounded: re-read it rather than adopting a collection
      // from the write's answer. A re-read failure is not a failed log — the
      // commit already succeeded, and the parent shows the read's own error.
      try {
        await this.props.onLogged?.();
      } catch {
        // The parent owns the read's error state.
      }
    } catch (error) {
      // A transport failure may still have committed; keeping `pending` makes
      // the retry a replay (it is cleared only on success).
      this.setState({
        busy: false,
        error: error instanceof NetworkError ? error.message : "Could not log the shower. Try again.",
      });
    }
  }

  render() {
    const { view, error: loadError, timezone } = this.props;
    const { draft, busy, error } = this.state;
    const history = view?.history ?? [];
    const recent = recentShowers(history);
    const earlier = earlierCount(history);
    return html`
      <section class="card showers" aria-labelledby="showers-heading">
        <h2 class="card__title" id="showers-heading">Showers</h2>
        <p class="placeholder" role="status" aria-live="polite">
          ${view === null ? (loadError ?? "Loading the shower history…") : (this.state.message ?? "")}
        </p>
        <!-- A failed re-read after a success must say the list may be stale. -->
        ${view !== null && loadError
          ? html`<p class="notice notice--error" role="alert">${loadError}</p>`
          : null}

        ${view === null
          ? null
          : html`
              <div class="showers__status">
                <p class="showers__due">${dueText(view.status)}</p>
                <p class="showers__meta">
                  ${lastShowerText(view.status)}
                  ${Number.isFinite(view.intervalDays) ? ` The household interval is ${intervalText(view.intervalDays)}.` : ""}
                </p>
              </div>
            `}

        <!-- The form works even when the read failed: logging is its own commit. -->
        <form class="form showers__form" onSubmit=${(event) => this.save(event)}>
          <h3 class="form__title">Log a shower</h3>
          <div class="field">
            <label for="shower-shampoo">Shampoo (optional)</label>
            <input
              id="shower-shampoo"
              name="shampoo"
              type="text"
              maxlength=${SHAMPOO_MAX}
              autocomplete="off"
              value=${draft.shampoo}
              onInput=${this.onInput}
              disabled=${busy}
            />
          </div>
          <div class="field">
            <label for="shower-notes">Note (optional)</label>
            <input
              id="shower-notes"
              name="notes"
              type="text"
              maxlength=${NOTES_MAX}
              autocomplete="off"
              value=${draft.notes}
              onInput=${this.onInput}
              disabled=${busy}
            />
            <p class="field__hint">The household date and who logged it come from the server.</p>
          </div>
          ${error ? html`<p class="notice notice--error" role="alert">${error}</p>` : null}
          <div class="form__actions">
            <button class="button" type="submit" disabled=${busy}>
              ${busy ? "Logging…" : "Log shower"}
            </button>
          </div>
        </form>

        ${view === null
          ? null
          : html`
              ${recent.length === 0
                ? html`<p class="placeholder">No showers logged yet.</p>`
                : html`
                    <ul class="showers__list" aria-label="Recent showers">
                      ${recent.map(
                        (row) => html`
                          <li class="shower" key=${row.id}>
                            <div class="shower__head">
                              <span class="shower__date">${dateText(row.localDate)}</span>
                              <span class="shower__meta">${showerMetaText(row, timezone)}</span>
                            </div>
                            ${row.shampoo ? html`<p class="shower__detail">Shampoo: ${row.shampoo}</p>` : null}
                            ${row.notes ? html`<p class="shower__note">${row.notes}</p>` : null}
                          </li>
                        `,
                      )}
                    </ul>
                    ${earlier > 0
                      ? html`<p class="showers__earlier">
                          ${earlier} earlier shower${earlier === 1 ? "" : "s"} not shown.
                        </p>`
                      : null}
                  `}
            `}
      </section>
    `;
  }
}
