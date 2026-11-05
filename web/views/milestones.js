// The milestone board (PLAN §13.1, §16 P3-05).
//
// A board grouped by status over P3-04's document: every row can move to
// another status (mastered / practicing / not started) with one idempotent
// commit, and a row's note can be set or cleared. Undo is an ordinary status
// change — the activity feed keeps who un-did it — never a delete.
//
// The rules this component shares with every other care surface:
//   * the board is read from `GET /api/training` (the care frame is a signal,
//     not data: P2-05), and every write's answer carries the committed board, so
//     the screen never merges a partial state;
//   * an action's idempotency key is held with the body it belongs to
//     (`pendingSave`, P1-11): a lost response retried with the same body replays
//     instead of changing the milestone twice;
//   * a refusal shows the one mapper's sentence (`{ error }`), never a stack;
//   * buttons are native controls inside a `<fieldset>`, so the board is
//     keyboard reachable; the status region is `role="status"`.
//
// The parent (`views/pup.js`) owns the fetch and passes `rows`; this component
// posts and hands the committed rows back up.

import { Component, h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { NetworkError, requestJson } from "../client.js";
import { pendingSave } from "../profile-form.js";
import {
  NOTE_MAX,
  STATUS_LABELS,
  TITLE_MAX,
  boardGroups,
  customMilestone,
  noteUpdate,
  rowMetaText,
  statusUpdate,
} from "../training.js";

const html = htm.bind(h);

/** Derived from the one label map, so a rename cannot drift between two lists. */
const STATUS_ACTIONS = Object.entries(STATUS_LABELS).map(([status, label]) => ({ status, label }));

/** One row: its status buttons and its note form, each one idempotent commit. */
class MilestoneRow extends Component {
  state = { busy: null, error: null, noteOpen: false, note: (this.props.row.note ?? ""), pending: null };

  componentDidUpdate(previous) {
    // A fresh committed row (the caregiver's own commit or a partner's) clears a
    // stale refusal: the notice was about a row that has since moved.
    if (previous.row !== this.props.row && this.state.error !== null) {
      this.setState({ error: null });
    }
    // A partner's note edit is adopted unless the form is open with a draft.
    const before = previous.row.note ?? "";
    const now = this.props.row.note ?? "";
    if (!this.state.noteOpen && before !== now && this.state.note !== now) {
      this.setState({ note: now });
    }
  }

  async send(body, label) {
    const pending = pendingSave(this.state.pending, body);
    this.setState({ busy: label, error: null, pending });
    this.props.onBusy(true);
    try {
      const result = await this.props.request("/api/training/milestone", {
        method: "POST",
        body,
        idempotencyKey: pending.key,
      });
      if (result.status === 401) {
        this.props.onBusy(false);
        this.setState({ busy: null, error: "Please sign in again." });
        return;
      }
      if (!result.ok) {
        // The mapper's key: the domain's rule or the unknown-milestone message.
        // An unknown-milestone 409 carries the current board (a catalog entry a
        // newer build removed): adopt it so the row that just vanished goes.
        if (Array.isArray(result.body?.milestones)) this.props.onRows(result.body.milestones);
        this.props.onBusy(false);
        this.setState({
          busy: null,
          error: result.body?.error ?? "Could not change the milestone. Try again.",
        });
        return;
      }
      this.props.onBusy(false);
      this.setState({
        busy: null,
        error: null,
        // Only the note action closes the note form: a status click must not
        // discard a draft the caregiver is typing.
        ...(label === "note" ? { noteOpen: false, note: this.props.row.note ?? "" } : {}),
        pending: null,
      });
      this.props.onRows(result.body.milestones);
    } catch (error) {
      // A transport failure may still have committed; keeping `pending` makes
      // the retry a replay (it is cleared only on success).
      this.props.onBusy(false);
      this.setState({
        busy: null,
        error: error instanceof NetworkError ? error.message : "Could not change the milestone. Try again.",
      });
    }
  }

  async setStatus(status) {
    if (this.state.busy !== null) return;
    await this.send(statusUpdate(this.props.row, status), `status:${status}`);
  }

  async saveNote(event) {
    event.preventDefault();
    if (this.state.busy !== null) return;
    await this.send(noteUpdate(this.props.row, this.state.note), "note");
  }

  render() {
    const { row, timezone } = this.props;
    const { busy, error, noteOpen, note } = this.state;
    const meta = rowMetaText(row, timezone);
    return html`
      <li class="milestone" data-status=${row.status}>
        <div class="milestone__head">
          <span class="milestone__title">${row.title}</span>
          ${row.origin === "custom" ? html`<span class="milestone__tag">ours</span>` : null}
        </div>
        ${meta ? html`<p class="milestone__meta">${meta}</p>` : null}
        ${row.note && !noteOpen ? html`<p class="milestone__note">${row.note}</p>` : null}
        <fieldset class="milestone__actions" disabled=${busy !== null}>
          <legend class="visually-hidden">Status for ${row.title}</legend>
          ${STATUS_ACTIONS.map(
            (action) => html`
              <button
                key=${action.status}
                type="button"
                class="button button--ghost milestone__status"
                aria-pressed=${row.status === action.status ? "true" : "false"}
                disabled=${busy !== null || this.props.boardBusy || row.status === action.status}
                onClick=${() => this.setStatus(action.status)}
              >
                ${busy === `status:${action.status}` ? "Saving…" : action.label}
              </button>
            `,
          )}
          <button
            type="button"
            class="button button--ghost milestone__note-toggle"
            aria-expanded=${noteOpen ? "true" : "false"}
            onClick=${() => this.setState({ noteOpen: !noteOpen, note: row.note ?? "" })}
            disabled=${busy !== null || this.props.boardBusy}
          >
            ${noteOpen ? "Cancel note" : row.note ? "Edit note" : "Add note"}
          </button>
        </fieldset>
        ${noteOpen
          ? html`
              <form class="milestone__note-form" onSubmit=${(event) => this.saveNote(event)}>
                <label class="visually-hidden" for=${`note-${row.id}`}>Note for ${row.title}</label>
                <input
                  id=${`note-${row.id}`}
                  type="text"
                  maxlength=${NOTE_MAX}
                  value=${note}
                  onInput=${(event) => this.setState({ note: event.target.value })}
                  disabled=${busy !== null || this.props.boardBusy}
                />
                <button class="button" type="submit" disabled=${busy !== null}>
                  ${busy === "note" ? "Saving…" : "Save note"}
                </button>
                <p class="field__hint">Leave it empty to clear the note.</p>
              </form>
            `
          : null}
        ${error ? html`<p class="notice notice--error" role="alert">${error}</p>` : null}
      </li>
    `;
  }
}

export class Milestones extends Component {
  /** `busy` is board-wide: one action at a time, so two commits cannot race. */
  state = { title: "", adding: false, pending: null, error: null, busy: false, message: null };

  setBusy(busy) {
    this.setState({ busy });
  }

  /**
   * Adopt a committed board. The lock means one write is in flight, so this is
   * always the newest answer; the message is the screen-reader confirmation the
   * status region would otherwise never give.
   */
  adopt(rows) {
    this.setState({ message: "Saved." });
    this.props.onRows(rows);
  }

  async add(event) {
    event.preventDefault();
    if (this.state.adding || this.state.busy) return;
    const body = customMilestone(this.state.title);
    if (body.title === "") {
      this.setState({ error: "Give the milestone a title." });
      return;
    }
    const pending = pendingSave(this.state.pending, body);
    this.setState({ adding: true, busy: true, error: null, pending });
    try {
      const result = await this.props.request("/api/training/custom", {
        method: "POST",
        body,
        idempotencyKey: pending.key,
      });
      if (!result.ok) {
        this.setState({
          adding: false,
          busy: false,
          error: result.body?.error ?? "Could not add the milestone. Try again.",
        });
        return;
      }
      this.setState({ adding: false, busy: false, title: "", pending: null, error: null, message: "Saved." });
      this.props.onRows(result.body.milestones);
    } catch (error) {
      this.setState({
        adding: false,
        busy: false,
        error: error instanceof NetworkError ? error.message : "Could not add the milestone. Try again.",
      });
    }
  }

  render() {
    const { rows, error: loadError } = this.props;
    const { title, adding, error } = this.state;
    const board = boardGroups(rows);
    const total = (rows ?? []).length;
    return html`
      <section class="card milestones" aria-labelledby="milestones-heading">
        <h2 class="card__title" id="milestones-heading">Milestones</h2>
        <p class="placeholder" role="status" aria-live="polite">
          ${rows === null ? (loadError ?? "Loading the milestone board…") : (this.state.message ?? "")}
        </p>
        ${rows === null
          ? null
          : board.map(
              (group) =>
                group.rows.length === 0
                  ? null
                  : html`
                      <section class="milestone-group" key=${group.status} aria-labelledby=${`group-${group.status}`}>
                        <h3 class="milestone-group__title" id=${`group-${group.status}`}>
                          ${group.label} (${group.rows.length})
                        </h3>
                        <ul class="milestone-group__list">
                          ${group.rows.map(
                            (row) =>
                              html`<${MilestoneRow}
                                key=${row.id}
                                row=${row}
                                timezone=${this.props.timezone}
                                request=${this.props.request}
                                boardBusy=${this.state.busy}
                                onBusy=${(busy) => this.setBusy(busy)}
                                onRows=${(next) => this.adopt(next)}
                              />`,
                          )}
                        </ul>
                      </section>
                  `,
            )}

        <form class="form milestones__form" onSubmit=${(event) => this.add(event)}>
          <h3 class="form__title">Add a milestone</h3>
          <div class="field">
            <label for="milestone-title">Title</label>
            <input
              id="milestone-title"
              type="text"
              maxlength=${TITLE_MAX}
              autocomplete="off"
              value=${title}
              onInput=${(event) => this.setState({ title: event.target.value })}
              disabled=${adding}
            />
            <p class="field__hint">
              ${total} milestone${total === 1 ? "" : "s"} on the board. The starter list is a checklist, not a
              schedule.
            </p>
          </div>
          ${error ? html`<p class="notice notice--error" role="alert">${error}</p>` : null}
          <div class="form__actions">
            <button class="button" type="submit" disabled=${adding || this.state.busy}>
              ${adding ? "Adding…" : "Add milestone"}
            </button>
          </div>
        </form>
      </section>
    `;
  }
}
