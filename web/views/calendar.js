// Calendar — the month grid, the agenda, and one appointment's detail (PLAN
// §13.1, §13.3, §16 P4-02).
//
// The screen reads its own range from `GET /api/appointments`; the `profile`
// frame is a signal, not data (P2-05), so a care commit bumps `careSeq` and this
// view re-reads. Both HTTP and the agent use the same domain functions, but the
// agent's write tools wait for P4-07: a schedule change needs a human
// confirmation, and the human path here is the confirmation.
//
// Rules the plan gives this screen, and what the code does:
//   * **never silently retime.** The form writes the household's wall clock; the
//     server stores it with its zone snapshot and derives the instant. A
//     differing zone is named, never converted;
//   * **a 409 `stale` is a state, not an error.** The other caregiver's current
//     appointment is shown, the draft is kept, and the next save is a deliberate
//     override (the profile form's rule);
//   * **one idempotency key per intended save**, held with the body it belongs to
//     (`pendingSave`, P1-11), so a double-tap or a lost response replays instead
//     of creating a second appointment;
//   * cancellation is a confirm step and a **state change**: the record stays,
//     marked cancelled, and the grid shows it that way.
//
// The class, not a hook: the shell serves no import map and the vendored hooks
// module imports a bare `preact` specifier (PLAN §13.2).

import { Component, h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { NetworkError, newIdempotencyKey, requestJson } from "../client.js";
import { pendingSave } from "../profile-form.js";
import { getState, subscribe } from "../store.js";
import { dateText } from "../clock.js";
import {
  DAY_CHIP_LIMIT,
  DURATION_MAX,
  DURATION_MIN,
  LOCATION_MAX,
  NOTES_MAX,
  TITLE_MAX,
  VET_MAX,
  appointmentBody,
  appointmentsByDate,
  blankDraft,
  chipText,
  draftFrom,
  durationText,
  monthGrid,
  monthLabel,
  monthOf,
  monthWindow,
  offsetOptions,
  offsetText,
  shiftMonth,
  statusLabel,
  timeRangeText,
  zoneNote,
} from "../calendar.js";

const html = htm.bind(h);

const SIGNED_OUT = "Please sign in again.";
const LOAD_FAILED = "Could not load the calendar. Try again in a moment.";
const SAVE_FAILED = "Could not save the appointment. Try again.";
const STALE_MESSAGE =
  "Someone else changed this appointment. Your draft is kept below; saving again replaces their change.";

/** A first cursor before the server's own today arrives. */
function deviceToday() {
  return new Date().toISOString().slice(0, 10);
}

export class Calendar extends Component {
  state = {
    /** The month the grid shows; corrected to the server's today on first load. */
    cursor: monthOf(deviceToday()),
    view: null,
    loading: true,
    error: null,
    message: null,
    /** The create/edit draft, or null when the form is closed. */
    form: null,
    busy: false,
    pending: null,
    /** The appointment whose detail is open, or null. */
    detailId: null,
    cancelOpen: false,
    /** The care-view sequence last acted on, so one frame triggers one re-read. */
    seenCare: -1,
  };

  componentDidMount() {
    this.request = this.props?.request ?? requestJson;
    this.unsubscribe = subscribe((state) => this.onStore(state));
    this.navigated = false;
    this.setState({ seenCare: getState().careSeq ?? 0 });
    void this.load();
  }

  componentWillUnmount() {
    this.unsubscribe?.();
  }

  onStore(state) {
    const seq = state?.careSeq ?? 0;
    if (seq === this.state.seenCare || seq === 0) return;
    this.setState({ seenCare: seq });
    void this.load();
  }

  /**
   * Read the grid's range. Arrival order is not freshness order: every read and
   * every commit bumps `loadSeq`, so a slow range cannot overwrite a newer one.
   * The first load adopts the server's month when the device's date is wrong.
   */
  async load(cursor = this.state.cursor) {
    const seq = (this.loadSeq = (this.loadSeq ?? 0) + 1);
    const window = monthWindow(cursor);
    let result;
    try {
      result = await this.request(`/api/appointments?from=${window.from}&to=${window.to}`);
    } catch (error) {
      if (seq !== this.loadSeq) return;
      this.setState({
        loading: false,
        error: error instanceof NetworkError ? error.message : LOAD_FAILED,
      });
      return;
    }
    if (seq !== this.loadSeq) return;
    if (result.status === 401) {
      this.setState({ loading: false, error: SIGNED_OUT });
      return;
    }
    if (!result.ok || !result.body) {
      this.setState({ loading: false, error: LOAD_FAILED });
      return;
    }
    const view = result.body;
    const serverMonth = monthOf(view.today);
    const sameMonth = serverMonth.year === cursor.year && serverMonth.month === cursor.month;
    if (!sameMonth && !this.navigated) {
      // The device's clock or zone is not the household's; show the month the
      // server calls today, once.
      this.setState({ cursor: serverMonth });
      void this.load(serverMonth);
      return;
    }
    this.setState({ view, loading: false, error: null, detailId: this.liveDetailId(view) });
  }

  /** Keep the open detail only while its record is in the loaded range. */
  liveDetailId(view) {
    const id = this.state.detailId;
    if (id === null) return null;
    return view.appointments.some((appointment) => appointment.id === id) ? id : null;
  }

  moveMonth(delta) {
    this.navigated = true;
    const cursor = shiftMonth(this.state.cursor, delta);
    this.setState({ cursor, message: null, error: null });
    // Pass the month explicitly rather than relying on a `setState` callback:
    // the fetch must start even before the class re-renders.
    void this.load(cursor);
  }

  goToday() {
    const today = this.state.view?.today;
    if (!today) return;
    this.navigated = false;
    const cursor = monthOf(today);
    this.setState({ cursor, message: null, error: null });
    void this.load(cursor);
  }

  openCreate(localDate) {
    const today = this.state.view?.today ?? deviceToday();
    const defaults = this.state.view?.defaultReminderOffsetsMin ?? [];
    this.setState({
      form: blankDraft(localDate ?? today, defaults),
      pending: null,
      detailId: null,
      cancelOpen: false,
      message: null,
      error: null,
    });
  }

  openEdit(appointment) {
    this.setState({ form: draftFrom(appointment), pending: null, message: null, error: null });
  }

  openDetail(id) {
    this.setState({ detailId: id, form: null, cancelOpen: false, message: null, error: null });
  }

  closeForm() {
    this.setState({ form: null, pending: null, busy: false });
  }

  closeDetail() {
    this.setState({ detailId: null, cancelOpen: false });
  }

  setField(field, value) {
    this.setState({ form: { ...this.state.form, [field]: value } });
  }

  toggleOffset(minutes) {
    const form = this.state.form;
    if (!form) return;
    const offsets = form.offsets.includes(minutes)
      ? form.offsets.filter((value) => value !== minutes)
      : [...form.offsets, minutes];
    this.setState({ form: { ...form, offsets } });
  }

  /** The save body, or the message that stops it before the wire. */
  draftProblem(draft) {
    if (String(draft.title ?? "").trim() === "") return "The appointment needs a title.";
    if (String(draft.localDate ?? "") === "") return "The appointment needs a date.";
    if (String(draft.timeLocal ?? "") === "") return "The appointment needs a time.";
    const duration = Math.round(Number(draft.durationMin));
    if (!Number.isFinite(duration) || duration < DURATION_MIN || duration > DURATION_MAX) {
      return `The duration is ${DURATION_MIN} to ${DURATION_MAX} minutes.`;
    }
    return null;
  }

  async save(event) {
    event.preventDefault();
    const form = this.state.form;
    if (!form || this.state.busy) return;
    const problem = this.draftProblem(form);
    if (problem !== null) {
      this.setState({ error: problem });
      return;
    }
    const body = appointmentBody(form);
    const edit = form.mode === "edit";
    const path = edit ? "/api/appointments/update" : "/api/appointments";
    const requestBody = edit ? { id: form.id, rev: form.rev, ...body } : body;
    const pending = pendingSave(this.state.pending, { path, body: requestBody });
    this.setState({ busy: true, pending, error: null, message: null });

    let result;
    try {
      result = await this.request(path, { method: "POST", body: requestBody, idempotencyKey: pending.key });
    } catch (error) {
      // An ambiguous failure: keep the key so the retry replays instead of
      // creating a second appointment.
      this.setState({ busy: false, error: error instanceof NetworkError ? error.message : SAVE_FAILED });
      return;
    }

    if (result.status === 401) {
      this.setState({ busy: false, error: SIGNED_OUT });
      return;
    }
    if (result.status === 409) {
      const answer = result.body ?? {};
      if (answer.error === "stale" && answer.appointment) {
        // Keep the caregiver's draft, adopt the committed revision, and show the
        // other caregiver's values in the detail below. The re-read is what makes
        // the detail (and the Cancel button's revision) the committed record.
        this.setState({
          busy: false,
          pending: null,
          message: STALE_MESSAGE,
          form: { ...form, rev: answer.appointment.rev },
          detailId: answer.appointment.id,
        });
        void this.load();
        return;
      }
      // `stale` and `idempotency_conflict` are codes with a sentence beside
      // them; the domain's other refusals put the sentence in `error` itself.
      this.setState({ busy: false, error: String(answer.message ?? answer.error ?? "The appointment was refused.") });
      return;
    }
    if (result.status === 404) {
      this.setState({
        busy: false,
        error: String(result.body?.message ?? result.body?.error ?? "That appointment is no longer in the calendar."),
      });
      void this.load();
      return;
    }
    if (!result.ok || !result.body) {
      this.setState({ busy: false, error: SAVE_FAILED });
      return;
    }

    this.setState({
      busy: false,
      form: null,
      pending: null,
      detailId: result.body.appointment?.id ?? null,
      message: result.body.replayed ? "Already saved; nothing new was written." : "Appointment saved.",
    });
    void this.load();
  }

  async cancel() {
    const form = this.detail();
    if (!form || this.state.busy) return;
    const body = { id: form.id, rev: form.rev };
    const pending = pendingSave(this.state.pending, { path: "/api/appointments/cancel", body });
    this.setState({ busy: true, pending, error: null, message: null });
    let result;
    try {
      result = await this.request("/api/appointments/cancel", {
        method: "POST",
        body,
        idempotencyKey: pending.key,
      });
    } catch (error) {
      this.setState({ busy: false, error: error instanceof NetworkError ? error.message : "Could not cancel the appointment." });
      return;
    }
    if (result.status === 401) {
      this.setState({ busy: false, error: SIGNED_OUT });
      return;
    }
    if (!result.ok) {
      const answer = result.body ?? {};
      this.setState({
        busy: false,
        cancelOpen: false,
        message: String(
          answer.message ??
            answer.error ??
            "The appointment changed before it could be cancelled; it has been re-read.",
        ),
      });
      void this.load();
      return;
    }
    this.setState({
      busy: false,
      cancelOpen: false,
      pending: null,
      message: result.body?.replayed ? "Already cancelled; nothing new was written." : "Appointment cancelled.",
    });
    void this.load();
  }

  /** The open detail's committed record, or null (a reload can remove it). */
  detail() {
    const id = this.state.detailId;
    if (id === null) return null;
    return (this.state.view?.appointments ?? []).find((appointment) => appointment.id === id) ?? null;
  }

  // --- rendering ------------------------------------------------------------

  renderNotice() {
    return html`
      <div class="form__status">
        ${
          this.state.error
            ? html`<p class="notice notice--error" role="alert">${this.state.error}</p>`
            : null
        }
        ${
          !this.state.error && this.state.message
            ? html`<p class="notice" role="status">${this.state.message}</p>`
            : null
        }
      </div>
    `;
  }

  renderToolbar() {
    const cursor = this.state.cursor;
    return html`
      <div class="calendar__toolbar">
        <button type="button" class="button button--ghost" aria-label="Previous month" onClick=${() => this.moveMonth(-1)}>‹</button>
        <h2 class="calendar__month" aria-live="polite">${monthLabel(cursor)}</h2>
        <button type="button" class="button button--ghost" aria-label="Next month" onClick=${() => this.moveMonth(1)}>›</button>
        <button type="button" class="button button--ghost" onClick=${() => this.goToday()} disabled=${!this.state.view}>Today</button>
        <button
          type="button"
          class="button"
          disabled=${this.state.loading && this.state.view === null}
          onClick=${() => this.openCreate()}
        >
          New appointment
        </button>
      </div>
    `;
  }

  renderDay(day, byDate) {
    const appointments = (byDate.get(day.date) ?? []).filter((appointment) => appointment.status !== "cancelled");
    const shown = appointments.slice(0, DAY_CHIP_LIMIT);
    const hidden = appointments.length - shown.length;
    const label = `${dateText(day.date)}${day.isToday ? ", today" : ""}: ${appointments.length} appointment${
      appointments.length === 1 ? "" : "s"
    }`;
    return html`
      <div
        key=${day.date}
        role="gridcell"
        class=${`calendar__day${day.inMonth ? "" : " calendar__day--outside"}${day.isToday ? " calendar__day--today" : ""}`}
        aria-label=${label}
      >
        <div class="calendar__day-head">
          <button
            type="button"
            class="calendar__day-number"
            aria-label=${`Add an appointment on ${dateText(day.date)}`}
            onClick=${() => this.openCreate(day.date)}
          >
            ${Number(day.date.slice(-2))}
          </button>
        </div>
        <ul class="calendar__chips">
          ${shown.map(
            (appointment) => html`
              <li key=${appointment.id}>
                <button
                  type="button"
                  class="calendar__chip"
                  title=${chipText(appointment)}
                  onClick=${() => this.openDetail(appointment.id)}
                >
                  ${appointment.timeLocal} ${appointment.title}
                </button>
              </li>
            `,
          )}
          ${hidden > 0 ? html`<li class="calendar__more">+${hidden} more</li>` : null}
        </ul>
      </div>
    `;
  }

  renderGrid() {
    const view = this.state.view;
    const grid = monthGrid(view?.today ?? deviceToday(), this.state.cursor);
    const byDate = appointmentsByDate(view?.appointments ?? []);
    return html`
      <div class="calendar__grid" role="grid" aria-label=${`${grid.label} appointments`}>
        <div class="calendar__weekdays" role="row">
          ${grid.weekdays.map((name) => html`<div key=${name} role="columnheader" class="calendar__weekday">${name}</div>`)}
        </div>
        ${grid.weeks.map(
          (week, index) => html`
            <div class="calendar__week" role="row" key=${`week-${index}`}>
              ${week.map((day) => this.renderDay(day, byDate))}
            </div>
          `,
        )}
      </div>
    `;
  }

  renderAgenda() {
    const view = this.state.view;
    if (!view) return null;
    const month = `${this.state.cursor.year}-${String(this.state.cursor.month).padStart(2, "0")}`;
    const rows = view.appointments.filter((appointment) => appointment.localDate.startsWith(month));
    return html`
      <section class="card calendar__agenda" aria-labelledby="calendar-agenda">
        <h2 id="calendar-agenda" class="card__title">Agenda</h2>
        ${
          rows.length === 0
            ? html`<p class="placeholder">No appointments this month.</p>`
            : html`
                <ul class="calendar__list">
                  ${rows.map(
                    (appointment) => html`
                      <li key=${appointment.id}>
                        <button
                          type="button"
                          class=${`calendar__row${appointment.status === "scheduled" ? "" : " calendar__row--muted"}`}
                          onClick=${() => this.openDetail(appointment.id)}
                        >
                          <span class="calendar__row-date">${dateText(appointment.localDate)}</span>
                          <span class="calendar__row-time">${timeRangeText(appointment)}</span>
                          <span class="calendar__row-title">${appointment.title}</span>
                          <span class="calendar__row-status">${statusLabel(appointment.status)}</span>
                        </button>
                      </li>
                    `,
                  )}
                </ul>
              `
        }
      </section>
    `;
  }

  renderDetail() {
    const appointment = this.detail();
    if (!appointment) return null;
    const view = this.state.view;
    const zoneMismatch = appointment.timezone !== view?.timezone;
    const cancelled = appointment.status !== "scheduled";
    return html`
      <section class="card calendar__detail" aria-labelledby="calendar-detail">
        <h2 id="calendar-detail" class="card__title">${appointment.title}</h2>
        <dl class="calendar__facts">
          <dt>When</dt>
          <dd>
            ${dateText(appointment.localDate)}, ${timeRangeText(appointment)}
            ${durationText(appointment.durationMin)}${zoneMismatch ? ` (${appointment.timezone})` : ""}
          </dd>
          ${appointment.location ? html`<dt>Where</dt><dd>${appointment.location}</dd>` : null}
          ${appointment.vetName ? html`<dt>Vet</dt><dd>${appointment.vetName}</dd>` : null}
          ${appointment.notes ? html`<dt>Notes</dt><dd>${appointment.notes}</dd>` : null}
          <dt>Reminders</dt>
          <dd>
            ${
              appointment.reminderOffsetsMin.length === 0
                ? "None"
                : appointment.reminderOffsetsMin.map((minutes) => html`<span class="calendar__tag" key=${minutes}>${offsetText(minutes)}</span>`)
            }
          </dd>
          <dt>Status</dt>
          <dd>${statusLabel(appointment.status)}${zoneMismatch ? ` · booked in ${appointment.timezone}` : ""}</dd>
        </dl>
        <div class="form__actions">
          ${
            cancelled
              ? null
              : html`
                  <button type="button" class="button" disabled=${this.state.busy} onClick=${() => this.openEdit(appointment)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    class="button button--ghost"
                    disabled=${this.state.busy}
                    onClick=${() => this.setState({ cancelOpen: true })}
                  >
                    Cancel appointment…
                  </button>
                `
          }
          <button type="button" class="button button--ghost" onClick=${() => this.closeDetail()}>Close</button>
        </div>
        ${
          this.state.cancelOpen
            ? html`
                <div class="notice notice--warn" role="group" aria-label="Confirm cancellation">
                  <p>Cancelling keeps the record in the calendar, marked cancelled. Its reminders stop.</p>
                  <div class="form__actions">
                    <button type="button" class="button" disabled=${this.state.busy} onClick=${() => void this.cancel()}>
                      ${this.state.busy ? "Cancelling…" : "Yes, cancel it"}
                    </button>
                    <button
                      type="button"
                      class="button button--ghost"
                      disabled=${this.state.busy}
                      onClick=${() => this.setState({ cancelOpen: false })}
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              `
            : null
        }
      </section>
    `;
  }

  renderForm() {
    const form = this.state.form;
    if (!form) return null;
    const editing = form.mode === "edit";
    const defaults = this.state.view?.defaultReminderOffsetsMin ?? [];
    // A create starts from the household's default; an edit shows the record's
    // own list. Both offer any offset either list carries, so nothing is lost.
    const options = offsetOptions(form.offsets, editing ? [] : defaults);
    return html`
      <form class="card calendar__form" aria-labelledby="calendar-form" onSubmit=${(event) => void this.save(event)}>
        <h2 id="calendar-form" class="card__title">${editing ? "Edit appointment" : "New appointment"}</h2>
        <div class="field">
          <label for="appointment-title">Title</label>
          <input
            id="appointment-title"
            type="text"
            required
            maxLength=${TITLE_MAX}
            value=${form.title}
            onInput=${(event) => this.setField("title", event.target.value)}
          />
        </div>
        <div class="calendar__row-fields">
          <div class="field">
            <label for="appointment-date">Date</label>
            <input
              id="appointment-date"
              type="date"
              required
              value=${form.localDate}
              onInput=${(event) => this.setField("localDate", event.target.value)}
            />
          </div>
          <div class="field">
            <label for="appointment-time">Time</label>
            <input
              id="appointment-time"
              type="time"
              required
              value=${form.timeLocal}
              onInput=${(event) => this.setField("timeLocal", event.target.value)}
            />
          </div>
          <div class="field">
            <label for="appointment-duration">Minutes</label>
            <input
              id="appointment-duration"
              type="number"
              min=${DURATION_MIN}
              max=${DURATION_MAX}
              step="5"
              value=${form.durationMin}
              onInput=${(event) => this.setField("durationMin", event.target.value)}
            />
          </div>
        </div>
        <p class="field__hint">
          Times are the household's wall clock${this.state.view ? ` (${this.state.view.timezone})` : ""}; a
          daylight-saving change does not move them.
        </p>
        ${
          editing && form.timezone && form.timezone !== this.state.view?.timezone
            ? html`<p class="field__hint">
                This appointment was booked in ${form.timezone}; saving re-anchors it to
                ${this.state.view?.timezone}.
              </p>`
            : null
        }
        <div class="field">
          <label for="appointment-location">Where (optional)</label>
          <input
            id="appointment-location"
            type="text"
            maxLength=${LOCATION_MAX}
            value=${form.location}
            onInput=${(event) => this.setField("location", event.target.value)}
          />
        </div>
        <div class="field">
          <label for="appointment-vet">Vet (optional)</label>
          <input
            id="appointment-vet"
            type="text"
            maxLength=${VET_MAX}
            value=${form.vetName}
            onInput=${(event) => this.setField("vetName", event.target.value)}
          />
        </div>
        <div class="field">
          <label for="appointment-notes">Notes (optional)</label>
          <input
            id="appointment-notes"
            type="text"
            maxLength=${NOTES_MAX}
            value=${form.notes}
            onInput=${(event) => this.setField("notes", event.target.value)}
          />
        </div>
        <fieldset class="calendar__reminders">
          <legend>Remind me</legend>
          ${options.map(
            (option) => html`
              <label key=${option.minutes} class="calendar__check">
                <input
                  type="checkbox"
                  checked=${option.checked}
                  onChange=${() => this.toggleOffset(option.minutes)}
                />
                ${option.label}
              </label>
            `,
          )}
        </fieldset>
        <p class="field__hint">Delivery arrives with the notification phase; the offsets are stored now.</p>
        <div class="form__actions">
          <button type="submit" class="button" disabled=${this.state.busy}>
            ${this.state.busy ? "Saving…" : editing ? "Save changes" : "Add appointment"}
          </button>
          <button type="button" class="button button--ghost" disabled=${this.state.busy} onClick=${() => this.closeForm()}>
            Cancel
          </button>
        </div>
      </form>
    `;
  }

  render() {
    const view = this.state.view;
    return html`
      <section class="view" aria-labelledby="calendar-heading">
        <h1 id="calendar-heading">Calendar</h1>
        <p class="field__hint">${view ? zoneNote(view.timezone) : "Times are in the household's zone."}</p>
        ${this.renderNotice()}
        ${this.renderToolbar()}
        ${
          this.state.loading && view === null
            ? html`<p class="placeholder">Loading the calendar…</p>`
            : html`${this.renderForm()} ${this.renderDetail()} ${this.renderGrid()} ${this.renderAgenda()}`
        }
      </section>
    `;
  }
}
