// Pup — the puppy profile and its growth card (PLAN §13.1).
//
// This build owns the profile fields (name, birthday, breed, sex, target
// weight) and P3-03's growth chart: the committed series drawn as an inline
// SVG over `growth-chart.js`'s pure geometry, the trend copy from P3-02, the
// target distance, and a form to log a weight. Milestones and showers join this
// screen with their own phases.
//
// Growth is read from `GET /api/growth`, never from the `profile` frame: P2-05
// made that frame a signal, not data, so a measurement bumps `careSeq` and this
// screen re-reads — the same rule Today follows for the day's meals. A local
// `loadSeq` makes a slow read lose to a newer one or to a committed write.
//
// Two rules shape the form:
//   * the save echoes the revision it read. A 409 `stale` is not an error: the
//     other caregiver changed the same profile, their values are shown, and the
//     draft is kept so saving again is a deliberate override rather than a
//     silent one (PLAN §7.4);
//   * the form is a Preact class, not a hook. The shell serves no import map and
//     `web/vendor/preact-hooks.mjs` imports a bare `preact` specifier, so hooks
//     are unavailable here by design (PLAN §13.2).

import { Component, h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";
import { NetworkError, requestJson } from "../client.js";
import { chartGeometry, formatKg, measurementRows, windowLabel } from "../growth-chart.js";
import { changedFields, draftOf, emptyDraft, isNewer, pendingSave, sameHousehold } from "../profile-form.js";
import { subscribe } from "../store.js";

const html = htm.bind(h);

const CONFLICT_MESSAGE =
  "Someone else changed this profile. Your edits are kept below; saving again replaces their change.";

const EMPTY_LOG = { weightKg: "", heightCm: "", note: "" };

/**
 * The chart: points and segments only, no smoothing. A segment longer than a
 * day is dashed by CSS (`growth-chart__gap`) and the caption says so, so a gap
 * in the weights never reads as a measured line. The numbers also live in the
 * table below, so the picture is never the only way to read the series.
 */
function GrowthChart({ points }) {
  const geometry = chartGeometry(points);
  if (geometry === null) {
    return html`<p class="placeholder">No measurements yet — log the first weight below.</p>`;
  }
  const { width, height, plot, dots, segments, yTicks, xTicks, hasGaps } = geometry;
  const described = `${dots.length} measurement${dots.length === 1 ? "" : "s"} between ${geometry.firstDate} and ${geometry.lastDate}; the table below lists them.`;
  return html`
    <figure class="growth-chart">
      <svg viewBox=${`0 0 ${width} ${height}`} role="img" aria-labelledby="growth-chart-title" aria-describedby="growth-chart-desc">
        <title id="growth-chart-title">Weight measurements</title>
        <desc id="growth-chart-desc">${described}</desc>
        <rect class="growth-chart__plot" x=${plot.x} y=${plot.y} width=${plot.width} height=${plot.height} />
        ${yTicks.map(
          (tick) => html`
            <g key=${`y-${tick.y}`}>
              <line class="growth-chart__grid" x1=${plot.x} y1=${tick.y} x2=${plot.x + plot.width} y2=${tick.y} />
              <text class="growth-chart__label" x=${plot.x - 8} y=${tick.y} text-anchor="end" dominant-baseline="middle">${tick.label}</text>
            </g>
          `,
        )}
        ${xTicks.map(
          (tick) => html`
            <text key=${`x-${tick.x}`} class="growth-chart__label" x=${tick.x} y=${plot.y + plot.height + 18} text-anchor="middle">${tick.label}</text>
          `,
        )}
        ${segments.map(
          (segment, index) => html`
            <line
              key=${`segment-${index}`}
              class=${segment.gap ? "growth-chart__gap" : "growth-chart__line"}
              x1=${segment.x1}
              y1=${segment.y1}
              x2=${segment.x2}
              y2=${segment.y2}
            />
          `,
        )}
        ${dots.map(
          (dot) => html`
            <circle key=${`dot-${dot.localDate}`} class="growth-chart__dot" cx=${dot.x} cy=${dot.y} r="3.5">
              <title>${`${dot.localDate}: ${formatKg(dot.weightKg)}`}</title>
            </circle>
          `,
        )}
      </svg>
      <figcaption class="growth-chart__caption">
        Weight in kilograms by household-local date.${hasGaps ? " A dashed line spans days without a measurement." : ""}
      </figcaption>
    </figure>
  `;
}

export class Pup extends Component {
  constructor(props) {
    super(props);
    // The test seam Today uses: production passes nothing.
    this.request = props?.request ?? requestJson;
  }

  state = {
    profile: null,
    /** The committed growth view from `GET /api/growth`; `null` until read. */
    growth: null,
    growthError: null,
    /** The last `careSeq` this screen re-read for (P2-05's signal). */
    seenCare: 0,
    draft: emptyDraft(),
    dirty: false,
    busy: false,
    error: null,
    message: null,
    conflict: null,
    /**
     * The idempotency key of the save currently on the wire (or last attempted),
     * with the body it belongs to. A retry of the *same* body must reuse the
     * key — that is what turns "the response was lost" into a replay instead of
     * a 409 against the caregiver's own edit. A changed draft changes the body,
     * so it gets a fresh key.
     */
    pending: null,
    /** The "log weight" form: its draft, its own key and its own notices. */
    log: EMPTY_LOG,
    logBusy: false,
    logError: null,
    logMessage: null,
    logPending: null,
  };

  componentDidMount() {
    this.unsubscribe = subscribe((state) => this.onStore(state));
    void this.load();
    void this.loadGrowth();
  }

  componentWillUnmount() {
    this.unsubscribe?.();
  }

  async load() {
    try {
      const result = await this.request("/api/puppy");
      if (result.status === 401) {
        this.setState({ error: "Please sign in again." });
        return;
      }
      if (!result.ok) {
        this.setState({ error: "Could not load the profile. Try again in a moment." });
        return;
      }
      this.setState({ profile: result.body, draft: draftOf(result.body), dirty: false, error: null });
    } catch (error) {
      this.setState({ error: error instanceof NetworkError ? error.message : "Could not load the profile." });
    }
  }

  /**
   * The committed growth view. The POST answer also carries it (used directly),
   * so a read that was in flight when the write committed must not overwrite the
   * newer series: `growthSeq` is bumped by every read and by every write.
   */
  async loadGrowth() {
    const seq = (this.growthSeq = (this.growthSeq ?? 0) + 1);
    try {
      const result = await this.request("/api/growth");
      if (seq !== this.growthSeq) return "superseded";
      if (result.status === 401) {
        this.setState({ growthError: "Please sign in again." });
        return "refused";
      }
      if (!result.ok) {
        this.setState({ growthError: "Could not load the measurements. Try again in a moment." });
        return "refused";
      }
      this.setState({ growth: result.body, growthError: null });
      return "loaded";
    } catch (error) {
      if (seq === this.growthSeq) {
        this.setState({
          growthError: error instanceof NetworkError ? error.message : "Could not load the measurements.",
        });
      }
      return "failed";
    }
  }

  /**
   * A frame from `live.js`. The shell re-renders the tree on every store change,
   * so this only has to keep the draft in step — and to re-read the growth the
   * frame only signals.
   *
   * Two kinds of change arrive on this one frame: a profile edit (the revision
   * moves) and a household change (a partner joined, the timezone changed, the
   * local day rolled over — the revision does not move). Only the first may
   * touch the draft or claim a conflict; the second replaces what is displayed
   * and leaves an in-progress edit alone.
   */
  onStore(state) {
    // A measurement moves no revision: `careSeq` is the re-read signal (P2-05).
    const seq = state?.careSeq ?? 0;
    if (seq !== this.state.seenCare) {
      this.setState({ seenCare: seq });
      void this.loadGrowth();
    }

    const incoming = state.profile;
    if (!incoming) return;
    const current = this.state.profile;

    if (current === null) {
      this.setState({ profile: incoming, draft: draftOf(incoming), conflict: null, message: null });
      return;
    }
    // Never go backwards: a frame that was already in flight when a save
    // returned carries an older revision, and the newest revision wins. The
    // whole view has three revisions (puppy, household, meals), so the shared
    // freshness rule decides — the same one the wizard uses.
    if (!isNewer(incoming, current)) return;

    if (incoming.rev > current.rev) {
      if (this.state.dirty) {
        this.setState({ profile: incoming, conflict: CONFLICT_MESSAGE });
        return;
      }
      this.setState({ profile: incoming, draft: draftOf(incoming), conflict: null, message: null });
      return;
    }

    // Same revision: the roster, the timezone or the household-local day moved.
    if (sameHousehold(current, incoming)) return;
    this.setState({ profile: incoming });
  }

  async save(event) {
    event.preventDefault();
    const { draft, profile, busy } = this.state;
    if (busy) return;
    if (profile === null) return;
    if (draft.name.trim() === "") {
      this.setState({ error: "The puppy needs a name before this can be saved." });
      return;
    }

    const patch = changedFields(profile.puppy, draft);
    if (Object.keys(patch).length === 0) {
      this.setState({ dirty: false, error: null, message: "No changes to save." });
      return;
    }

    const body = { rev: profile.rev, ...patch };
    const pending = pendingSave(this.state.pending, body);

    this.setState({ busy: true, error: null, message: null, pending });
    try {
      const result = await requestJson("/api/puppy", {
        method: "PATCH",
        body,
        idempotencyKey: pending.key,
      });
      if (result.status === 401) {
        this.setState({ busy: false, error: "Please sign in again." });
        return;
      }
      if (result.status === 409 && result.body?.error === "stale") {
        // Keep the draft, adopt the other caregiver's revision and show their
        // values; the next save is then a knowing replacement (and a new body,
        // so a new key).
        this.setState({
          busy: false,
          profile: result.body.profile,
          dirty: true,
          conflict: CONFLICT_MESSAGE,
          pending: null,
        });
        return;
      }
      if (!result.ok) {
        // The one failure mapper answers `{ error }`; a rev conflict answers
        // `{ error: "stale", message }` and was handled above.
        // The key stays pending: another attempt at the same body replays it.
        this.setState({
          busy: false,
          error: result.body?.error ?? result.body?.message ?? "Could not save. Try again.",
        });
        return;
      }
      const saved = result.body.profile;
      this.setState({
        busy: false,
        profile: saved,
        draft: draftOf(saved),
        dirty: false,
        conflict: null,
        pending: null,
        message: result.body.replayed ? "Already saved." : "Saved.",
      });
    } catch (error) {
      // A transport failure may still have committed; keeping `pending` is what
      // makes the retry a replay (the key is cleared on success).
      this.setState({
        busy: false,
        error: error instanceof NetworkError ? error.message : "Could not save. Try again.",
      });
    }
  }

  onLogInput = (event) => {
    const { name, value } = event.target;
    this.setState({ log: { ...this.state.log, [name]: value }, logMessage: null });
  };

  /**
   * Log one weight. The key stays with the body (P1-11's rule): a lost response
   * retried with the same numbers replays instead of logging twice, and an
   * edited draft is a new action with a fresh key. Growth has no revision, so
   * there is no stale answer to handle — a refusal is a sentence from the
   * domain (`MEASUREMENT_RULE`) and nothing is written.
   */
  async logWeight(event) {
    event.preventDefault();
    const { log, logBusy, profile } = this.state;
    if (logBusy || profile === null) return;
    const weightKg = Number(log.weightKg);
    if (log.weightKg.trim() === "" || !Number.isFinite(weightKg) || weightKg <= 0) {
      this.setState({ logError: "Enter the weight in kilograms, for example 4.25." });
      return;
    }
    const body = { weightKg };
    if (log.heightCm.trim() !== "") {
      const heightCm = Number(log.heightCm);
      // A number input can still hand over a partial value; sending `NaN` would
      // serialise as null and commit the measurement *without* the height.
      if (!Number.isFinite(heightCm) || heightCm <= 0) {
        this.setState({ logError: "The height is a number of centimetres, or left empty." });
        return;
      }
      body.heightCm = heightCm;
    }
    if (log.note.trim() !== "") body.note = log.note.trim();
    const pending = pendingSave(this.state.logPending, body);

    this.setState({ logBusy: true, logError: null, logMessage: null, logPending: pending });
    try {
      const result = await this.request("/api/growth", {
        method: "POST",
        body,
        idempotencyKey: pending.key,
      });
      if (result.status === 401) {
        this.setState({ logBusy: false, logError: "Please sign in again." });
        return;
      }
      if (!result.ok) {
        // The mapper's key, so the domain's rule reaches the caregiver instead
        // of a generic sentence (the key-conflict 409 carries both).
        this.setState({
          logBusy: false,
          logError: result.body?.error ?? result.body?.message ?? "Could not log the weight. Try again.",
        });
        return;
      }
      // The answer carries the committed growth view: adopt it now so the chart
      // moves even before the frame arrives, and invalidate any read in flight.
      this.growthSeq = (this.growthSeq ?? 0) + 1;
      this.setState({
        logBusy: false,
        growth: result.body.growth,
        log: EMPTY_LOG,
        logMessage: result.body.replayed ? "Already logged." : "Logged.",
        logPending: null,
      });
    } catch (error) {
      // A transport failure may still have committed; the pending key makes the
      // retry a replay (it is cleared only on success).
      this.setState({
        logBusy: false,
        logError: error instanceof NetworkError ? error.message : "Could not log the weight. Try again.",
      });
    }
  }

  onInput = (event) => {
    const { name, value } = event.target;
    this.setState({ draft: { ...this.state.draft, [name]: value }, dirty: true, message: null });
  };

  render() {
    const { profile, growth, growthError, draft, busy, error, message, conflict, log, logBusy, logError, logMessage } =
      this.state;

    if (profile === null) {
      return html`
        <section class="view" aria-labelledby="pup-heading">
          <h1 id="pup-heading">Pup</h1>
          ${error
            ? html`<p class="notice notice--error" role="alert">${error}</p>`
            : html`<p class="placeholder">Loading the puppy profile…</p>`}
        </section>
      `;
    }

    const age = profile.age ? profile.age.label : "no birthday yet";
    const caregivers = profile.household.members.map((member) => member.name).join(" and ");

    return html`
      <section class="view" aria-labelledby="pup-heading">
        <h1 id="pup-heading">${profile.puppy.name || "Your pup"}</h1>
        <p class="lead">
          <span>${age}</span>
          ${caregivers ? html`<span class="lead__meta"> · ${caregivers}</span>` : null}
        </p>

        <form class="card form" onSubmit=${(event) => this.save(event)}>
          <h2 class="card__title">Profile</h2>

          <div class="field">
            <label for="pup-name">Name</label>
            <input
              id="pup-name"
              name="name"
              type="text"
              maxlength="60"
              required
              autocomplete="off"
              value=${draft.name}
              onInput=${this.onInput}
              disabled=${busy}
            />
          </div>

          <div class="field">
            <label for="pup-birthday">Birthday</label>
            <input
              id="pup-birthday"
              name="birthday"
              type="date"
              value=${draft.birthday}
              onInput=${this.onInput}
              disabled=${busy}
            />
            <p class="field__hint">The household date (${profile.household.timezone}); age is worked out from it.</p>
          </div>

          <div class="field">
            <label for="pup-breed">Breed</label>
            <input
              id="pup-breed"
              name="breed"
              type="text"
              maxlength="60"
              autocomplete="off"
              value=${draft.breed}
              onInput=${this.onInput}
              disabled=${busy}
            />
          </div>

          <div class="field">
            <label for="pup-sex">Sex</label>
            <select id="pup-sex" name="sex" value=${draft.sex} onChange=${this.onInput} disabled=${busy}>
              <option value="">Not set</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </div>

          <div class="field">
            <label for="pup-weight">Target weight (kg)</label>
            <input
              id="pup-weight"
              name="targetWeightKg"
              type="number"
              min="0.1"
              max="200"
              step="0.01"
              inputmode="decimal"
              value=${draft.targetWeightKg}
              onInput=${this.onInput}
              disabled=${busy}
            />
          </div>

          ${conflict ? html`<p class="notice notice--warn" role="status">${conflict}</p>` : null}
          ${error ? html`<p class="notice notice--error" role="alert">${error}</p>` : null}

          <div class="form__actions">
            <button class="button" type="submit" disabled=${busy}>
              ${busy ? "Saving…" : "Save profile"}
            </button>
            <span class="form__status" role="status" aria-live="polite">${message ?? ""}</span>
          </div>
        </form>

        <section class="card growth" aria-labelledby="growth-heading">
          <h2 class="card__title" id="growth-heading">Growth</h2>
          ${growth === null
            ? html`<p class="placeholder">${growthError ?? "Loading the measurements…"}</p>`
            : html`
                ${html`<${GrowthChart} points=${growth.points} />`}
                ${growth.summary?.windows?.length
                  ? html`<ul class="growth__windows" aria-label="Recent trend by period">
                      ${growth.summary.windows.map(
                        (window) => html`<li key=${`window-${window.days}`}>
                          <span class="growth__window-days">${window.days}-day</span> ${windowLabel(window)}
                        </li>`,
                      )}
                    </ul>`
                  : null}
                ${growth.lines.map(
                  (line, index) =>
                    html`<p key=${`line-${index}`} class=${line.role === "note" ? "growth__trend" : "growth__fineprint"}>${line.text}</p>`,
                )}
              `}

          <details class="growth__history">
            <summary>All measurements (${growth?.points.length ?? 0})</summary>
            <table class="growth__table">
              <thead>
                <tr><th scope="col">Date</th><th scope="col">Weight</th><th scope="col">Height</th></tr>
              </thead>
              <tbody>
                ${measurementRows(growth?.points ?? []).map(
                  (row) =>
                    html`<tr key=${row.localDate}>
                      <th scope="row">${row.localDate}</th>
                      <td>${row.weightKg}</td>
                      <td>${row.heightCm || "—"}</td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </details>

          <form class="form growth__form" onSubmit=${(event) => this.logWeight(event)}>
            <h3 class="form__title">Log a weight</h3>
            <div class="field">
              <label for="growth-weight">Weight (kg)</label>
              <input
                id="growth-weight"
                name="weightKg"
                type="number"
                min="0.001"
                max="200"
                step="0.001"
                inputmode="decimal"
                required
                value=${log.weightKg}
                onInput=${this.onLogInput}
                disabled=${logBusy}
              />
              <p class="field__hint">Grams are fine: 4.237 kg.</p>
            </div>
            <div class="field">
              <label for="growth-height">Height (cm, optional)</label>
              <input
                id="growth-height"
                name="heightCm"
                type="number"
                min="0.1"
                max="200"
                step="0.1"
                inputmode="decimal"
                value=${log.heightCm}
                onInput=${this.onLogInput}
                disabled=${logBusy}
              />
            </div>
            <div class="field">
              <label for="growth-note">Note (optional)</label>
              <input
                id="growth-note"
                name="note"
                type="text"
                maxlength="280"
                autocomplete="off"
                value=${log.note}
                onInput=${this.onLogInput}
                disabled=${logBusy}
              />
            </div>
            ${logError ? html`<p class="notice notice--error" role="alert">${logError}</p>` : null}
            <div class="form__actions">
              <button class="button" type="submit" disabled=${logBusy}>
                ${logBusy ? "Logging…" : "Log weight"}
              </button>
              <span class="form__status" role="status" aria-live="polite">${logMessage ?? ""}</span>
            </div>
          </form>
        </section>
      </section>
    `;
  }
}
