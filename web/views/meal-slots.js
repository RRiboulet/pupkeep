// The meal-slot editor, shared by the first-run wizard (P1-14) and the Settings
// "Meal times" card (P4-11).
//
// Why it is a module of its own: two screens edit the same schedule, and a
// second copy of the fieldset markup, the draft shaping, the pure slot edits or
// `wireSlots` would let them drift — one screen could accept a time the other
// refuses, store a shape the document parser rejects, or report the same
// refusal with a different sentence. The wizard's markup and ARIA are moved
// here verbatim, and the pure edits and copy live here too, so the two cannot
// disagree about what a slot row is or what a schedule means.
//
// What stays in each parent: the schedule's revision, the save, the idempotency
// key and the conflict banner's wiring to the live frame. Those are per-screen
// state, not slot shapes. The component is presentational: it owns no schedule
// state and no request.

import { Component, h } from "../vendor/preact.mjs";
import htm from "../vendor/htm.mjs";

const html = htm.bind(h);

/** The server's `MEAL_SLOTS_MAX`; the web cannot import `src/shared`, so the one cap lives here. */
export const MEAL_SLOTS_MAX = 12;

/** The one sentence a schedule conflict answers with, shared by both screens. */
export const CONFLICT_MESSAGE =
  "Someone else changed the meal times while you were editing. Your values are kept below; saving again replaces their change.";

/** The one hint above the editor, shared so the two screens cannot drift. */
export const SLOT_HINT =
  "Times are on this household's clock. Inactive meals stay in the schedule but are not expected each day.";

/** A new household's suggested meals; the caregiver edits them before saving. */
const SUGGESTED_SLOTS = [
  { label: "Breakfast", timeLocal: "07:00" },
  { label: "Lunch", timeLocal: "12:00" },
  { label: "Dinner", timeLocal: "18:00" },
];

export function slotId() {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return `slot-${crypto.randomUUID()}`;
  if (crypto?.getRandomValues) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return `slot-${hex}`;
  }
  return `slot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function suggestedSlots() {
  return SUGGESTED_SLOTS.map((slot) => ({
    id: slotId(),
    label: slot.label,
    timeLocal: slot.timeLocal,
    portion: "",
    active: true,
  }));
}

export function slotDraftsOf(slots) {
  return slots.map((slot) => ({
    id: slot.id,
    label: slot.label,
    timeLocal: slot.timeLocal,
    portion: slot.portion ?? "",
    active: slot.active,
  }));
}

/** The drafts for a committed schedule; an empty one offers the suggestions. */
export function scheduleDrafts(meals) {
  return meals.slots.length > 0 ? slotDraftsOf(meals.slots) : suggestedSlots();
}

/** One field of one slot changed; the rest of the draft is untouched. */
export function editSlot(slots, index, field, value) {
  return slots.map((slot, position) => (position === index ? { ...slot, [field]: value } : slot));
}

export function toggleSlot(slots, index) {
  return slots.map((slot, position) => (position === index ? { ...slot, active: !slot.active } : slot));
}

/** The capped append both screens share; at the cap it returns the same list. */
export function appendSlot(slots) {
  if (slots.length >= MEAL_SLOTS_MAX) return slots;
  return [
    ...slots,
    { id: slotId(), label: `Meal ${slots.length + 1}`, timeLocal: "12:00", portion: "", active: true },
  ];
}

/** Drop one slot by position; the rest keep their order. */
export function removeSlotAt(slots, index) {
  return slots.filter((_slot, position) => position !== index);
}

/** The wire shape; empty portions are omitted rather than stored as "". */
export function wireSlots(slots) {
  return slots.map((slot) => {
    const portion = slot.portion.trim();
    return {
      id: slot.id,
      label: slot.label.trim(),
      // `<input type="time">` gives `HH:MM`; a browser that adds seconds is
      // still the same wall-clock minute, and the server's parser wants HH:MM.
      timeLocal: String(slot.timeLocal).slice(0, 5),
      ...(portion === "" ? {} : { portion }),
      active: Boolean(slot.active),
    };
  });
}

/**
 * The slot list and its "Add a meal" button, as the wizard has always rendered
 * it. Props: `slots` (drafts), `busy`, and the four edit callbacks
 * (`onInput(index, field, value)`, `onToggle(index)`, `onAdd`, `onRemove(index)`).
 */
export class MealSlots extends Component {
  render() {
    const { slots, busy, onInput, onToggle, onAdd, onRemove } = this.props;
    return html`
      ${slots.map(
        (slot, index) => html`
          <fieldset class="slot" key=${slot.id}>
            <legend class="slot__legend">Meal ${index + 1}</legend>
            <div class="field">
              <label for=${`slot-label-${slot.id}`}>Name</label>
              <input
                id=${`slot-label-${slot.id}`}
                type="text"
                maxlength="40"
                value=${slot.label}
                onInput=${(event) => onInput(index, "label", event.target.value)}
                disabled=${busy}
              />
            </div>
            <div class="slot__row">
              <div class="field">
                <label for=${`slot-time-${slot.id}`}>Time</label>
                <input
                  id=${`slot-time-${slot.id}`}
                  type="time"
                  value=${slot.timeLocal}
                  onInput=${(event) => onInput(index, "timeLocal", event.target.value)}
                  disabled=${busy}
                />
              </div>
              <div class="field">
                <label for=${`slot-portion-${slot.id}`}>Portion</label>
                <input
                  id=${`slot-portion-${slot.id}`}
                  type="text"
                  maxlength="80"
                  value=${slot.portion}
                  onInput=${(event) => onInput(index, "portion", event.target.value)}
                  disabled=${busy}
                />
              </div>
            </div>
            <div class="slot__actions">
              <label class="slot__active">
                <input
                  type="checkbox"
                  checked=${slot.active}
                  onChange=${() => onToggle(index)}
                  disabled=${busy}
                />
                Expected every day
              </label>
              <button
                class="button button--ghost"
                type="button"
                onClick=${() => onRemove(index)}
                disabled=${busy || slots.length <= 1}
              >
                Remove
              </button>
            </div>
          </fieldset>
        `,
      )}
      <div class="form__actions">
        <button
          class="button button--ghost"
          type="button"
          onClick=${onAdd}
          disabled=${busy || slots.length >= MEAL_SLOTS_MAX}
        >
          Add a meal
        </button>
      </div>
    `;
  }
}
