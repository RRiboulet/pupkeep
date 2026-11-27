// The first-run wizard used to read "Boot capturedEurope/Paris", and the
// Settings lead "Our household· Europe/Paris · Owner and Sam": both sentences
// were built from a text run followed by an expression on the next line, and
// htm drops that whitespace. They are composed in `web/household.js` for the
// same reason `startedText()` is composed in `web/walks.js` — the separator is
// part of the text, so a test can pin it. These assertions fail if either
// sentence is split back into markup.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bootZoneHint, householdLeadMetaText } from "../web/household.js";
import { setState } from "../web/store.js";
import { Settings } from "../web/views/settings.js";
import { Setup } from "../web/views/setup.js";

test("the wizard's boot-zone hint keeps a space before the captured zone", () => {
  assert.equal(
    bootZoneHint("Europe/Paris"),
    "Every date in Pupkeep — meals, walks, growth — is worked out in this zone. " +
      "Boot captured Europe/Paris; please check it.",
  );
});

// The lead is `${household.name}` followed by the meta span, so the space that
// belongs before the FIRST separator is the meta's own leading space (the same
// place `web/views/pup.js` puts it): htm drops the template whitespace between
// the name and the span, so only a space inside the string survives.
test("the Settings lead keeps spaces around every separator", () => {
  assert.equal(
    householdLeadMetaText("Europe/Paris", ["Owner", "Sam"]),
    " · Europe/Paris · Owner and Sam",
  );
});

test("one caregiver still reads with a space after the last separator", () => {
  assert.equal(householdLeadMetaText("UTC", ["Alex"]), " · UTC · Alex");
});

// A correct helper is not enough: the templates must actually use it as a
// single string. These render checks fail if either is split back into markup.
function renderedText(node, out = []) {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((child) => renderedText(child, out));
  else if (node && typeof node === "object") renderedText(node.props?.children, out);
  return out.join("");
}

const profile = {
  puppy: { name: "Biscuit", birthday: "2026-08-08", breed: "Beagle", sex: "female", targetWeightKg: 12 },
  age: { label: "11 weeks old" },
  household: {
    name: "Our household",
    timezone: "Europe/Paris",
    members: [{ name: "Owner" }, { name: "Sam" }],
  },
  meals: { slots: [] },
  setup: { complete: true, missing: [] },
  today: "2026-11-27",
};

test("the wizard renders the composed hint, not a glued sentence", () => {
  const setup = new Setup({});
  setup.state = {
    profile,
    zone: "Europe/Paris",
    puppy: { name: "Biscuit", birthday: "2026-08-08", breed: "Beagle", sex: "female", targetWeightKg: "" },
    slots: [],
    busy: null,
    error: null,
    message: null,
    conflict: null,
  };
  const text = renderedText(setup.render());
  assert.ok(text.includes(bootZoneHint("Europe/Paris")), "the wizard uses the composed hint");
  assert.ok(!text.includes("Boot capturedEurope/Paris"), "the zone has a space before it");
});

test("the Settings lead renders the composed meta, not a glued name", () => {
  setState({ profile });
  const text = renderedText(new Settings({ request: async () => ({}) }).render());
  assert.ok(text.includes(householdLeadMetaText("Europe/Paris", ["Owner", "Sam"])));
  assert.ok(!text.includes("·Owner"), "the name has a space after the separator");
});

test("the Settings lead renders as one fully spaced sentence", () => {
  setState({ profile });
  const text = renderedText(new Settings({ request: async () => ({}) }).render());
  assert.ok(
    text.includes("Our household · Europe/Paris · Owner and Sam"),
    "every separator, including the one after the household name, has its spaces",
  );
  assert.ok(!text.includes("household·"), "the household name is not glued to the first separator");
});
