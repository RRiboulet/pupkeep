// The app in a real browser (PLAN §15.5).
//
// Why this file exists. Every other suite either drives a view with a fake
// `request` (`test/client.test.js`), the real `requestJson` with a bridged
// browser (`test/owner-ui.test.js`), or the server with hand-built requests. All
// three are green while a phone shows a screen the product does not have: the
// bottom nav was 459 px wide inside a 360 px viewport, so the sixth tab sat
// outside the screen on every phone. No suite had ever laid the app out, so
// nothing measured it — CSS is not in any of those seams.
//
// So: boot the real app on a real port, open it in a real Chromium at the phone
// widths PLAN §15.4 records, and assert that the layout does not leave the
// viewport and that every screen actually paints. The nav's own row width is
// the load-bearing assertion; the document-level check beside it is a general
// guard for wide content elsewhere (it cannot see this bug: the nav is
// `position: fixed`, so the document never grew a scrollbar to complain about).
//
// The browser is a devDependency, not a runtime one (the phone never runs it),
// and it is not downloaded by `npm ci`. When the binary is missing this suite
// skips rather than fails, so a fresh container or an offline machine still runs
// the other 800-odd tests; CI installs it (`.github/workflows/ci.yml`) and the
// devcontainer does too (`.devcontainer/postCreate.sh`), which is where the gate
// actually holds.

// The functions handed to `page.evaluate` run in the browser, so they need the
// DOM lib. `/// <reference lib="dom" />` adds it to the *program*, not to this
// file — measured, not assumed — so nothing stops a `src/` file adding the same
// line. What it does buy: the project's default stays DOM-free, so a stray
// `document` in server code is a compile error until someone opts in here.
// Only a second tsconfig for `test/` would scope it properly, and that is not
// worth the machinery for one file.
/// <reference lib="dom" />

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { SESSION_COOKIE } from "../src/server/auth.ts";
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from "../src/server/http.ts";
import { startTestApp, type TestApp } from "./support/app.ts";

/** The widths PLAN §15.4 has to work at: old and current phones, both platforms. */
const PHONE_WIDTHS = [
  { width: 320, height: 568, label: "iPhone SE (1st gen)" },
  { width: 360, height: 800, label: "small Android" },
  { width: 390, height: 844, label: "iPhone 14" },
  { width: 430, height: 932, label: "iPhone Pro Max" },
] as const;

/**
 * What each screen's heading must say. The *routes* are not listed here: they
 * are read from the rendered nav of the **configured** fixture, so a seventh
 * tab cannot be added without this table being told about it. The unconfigured
 * fixture has its own test below: its first screen — in every viewport — is
 * the mandatory setup page, with no nav painted at all.
 */
const SCREENS: Readonly<Record<string, RegExp>> = {
  today: /^Today$/,
  calendar: /^Calendar$/,
  // The Pup screen's heading is the puppy's name ("Your pup" while unnamed);
  // `completeSetup` names this fixture's puppy Biscuit.
  pup: /^Biscuit$/,
  agent: /^Agent$/,
  notifications: /^Notifications$/,
  settings: /^Settings$/,
};

const NOT_INSTALLED =
  "no Playwright Chromium is installed, so the render checks are skipped: run `npx playwright install --with-deps chromium`";

let setupFixture: TestApp | undefined;
let homeFixture: TestApp | undefined;
let browser: Browser | undefined;
let chromium: typeof import("playwright").chromium | undefined;
let skipReason: string | undefined;

before(async () => {
  // Imported here, not at the top of the file: under `npm ci --omit=dev` the
  // package is absent and a static import would fail the whole run instead of
  // skipping these three tests.
  try {
    ({ chromium } = await import("playwright"));
  } catch (error) {
    // CI installs the package and the browser, so a gap there is a broken gate,
    // not a reason to skip: a green run that tested nothing is the failure mode
    // this check exists to prevent.
    if (process.env.CI !== undefined) throw error;
    skipReason = NOT_INSTALLED;
    return;
  }
  if (!existsSync(chromium.executablePath())) {
    if (process.env.CI !== undefined) throw new Error(NOT_INSTALLED);
    skipReason = NOT_INSTALLED;
    return;
  }
  setupFixture = await startTestApp({ prefix: "pupkeep-browser-setup-" });
  homeFixture = await startTestApp({ prefix: "pupkeep-browser-home-" });
  await completeSetup(homeFixture);
  browser = await chromium.launch();
});

// Each side in its own `try`: a browser that fails to close must not keep the app
// (and its listener and temp directory) alive, or the run hangs until CI's
// timeout instead of going red.
after(async () => {
  try {
    await browser?.close();
  } finally {
    await setupFixture?.stop();
    await homeFixture?.stop();
  }
});

/**
 * Complete the five setup steps through the real routes, so the fixture's
 * household reports `setup.complete` and the shell paints the ordinary app.
 * The timezone step is already done — `startTestApp` sets the zone through the
 * same household route.
 */
async function completeSetup(app: TestApp): Promise<void> {
  const write = async (path: string, method: string, body: unknown, key: string): Promise<Response> =>
    fetch(`${app.url}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        [REQUEST_HEADER]: REQUEST_HEADER_VALUE,
        "Idempotency-Key": key,
        Cookie: `${SESSION_COOKIE}=${app.cookies.owner}`,
        Origin: app.url,
      },
      body: JSON.stringify(body),
    });
  const named = await write("/api/household", "PATCH", { rev: (await app.profile()).household.rev, name: "The Burrow" }, "browser-name");
  assert.equal(named.status, 200, "the household name is confirmable");
  const afterName = await app.profile();
  const puppied = await write("/api/puppy", "PATCH", { rev: afterName.rev, name: "Biscuit" }, "browser-puppy");
  assert.equal(puppied.status, 200, "the puppy is nameable");
  const afterPuppy = await app.profile();
  const fed = await write(
    "/api/feeding/slots",
    "PATCH",
    { rev: afterPuppy.meals.rev, slots: [{ id: "slot-a", label: "Breakfast", timeLocal: "07:00", active: true }] },
    "browser-meals",
  );
  assert.equal(fed.status, 200, "the meal schedule is storable");
  const keyed = await write("/api/models/keys", "PUT", { provider: "opencode-go", key: "faux-key-for-setup" }, "browser-key");
  assert.equal(keyed.status, 200, "the provider key is storable");
  const done = await app.profile();
  assert.equal(done.setup.complete, true, "the five steps complete the fixture's setup");
}

/** The geometry of the bottom nav, in the page. */
const NAV_GEOMETRY = () => {
  const nav = document.querySelector(".bottom-nav");
  if (nav === null) throw new Error("the bottom nav did not render");
  const padding = (element: Element): number => {
    const style = getComputedStyle(element);
    return Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  };
  const naturalWidth = (element: Element): number => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getBoundingClientRect().width;
  };
  return {
    documentScrollWidth: document.documentElement.scrollWidth,
    navScrollWidth: nav.scrollWidth,
    navClientWidth: nav.clientWidth,
    links: [...nav.querySelectorAll("a")].map((link) => {
      const box = link.getBoundingClientRect();
      return {
        name: link.getAttribute("aria-label") ?? (link.textContent ?? "").trim(),
        // What the label needs to be readable, padding included, versus the box
        // the browser gave it: a wider label is visibly cut or spilled.
        requires: Math.round(naturalWidth(link) + padding(link)),
        box: Math.round(box.width),
        left: Math.round(box.left),
        right: Math.round(box.right),
      };
    }),
  };
};

/**
 * The colours the app is actually painting, with the token values it claims to
 * use. `color-scheme: light dark` alone changes nothing visible; only the media
 * block's token overrides do, so the assertions compare computed colours to the
 * tokens that are live in that scheme.
 */
const SCHEME_COLORS = () => {
  const root = getComputedStyle(document.documentElement);
  const toRgb = (value: string): string => {
    if (!value.startsWith("#")) return value;
    const digits = value.slice(1);
    const full = digits.length === 3 ? digits.split("").map((digit) => digit + digit).join("") : digits;
    const number = Number.parseInt(full, 16);
    return `rgb(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255})`;
  };
  const painted = (selector: string, property: "backgroundColor" | "color"): string => {
    const element = document.querySelector(selector);
    if (element === null) throw new Error(`${selector} did not render`);
    return getComputedStyle(element)[property];
  };
  const names = ["bg", "surface", "ink", "muted", "accent"] as const;
  return {
    prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
    tokens: Object.fromEntries(names.map((name) => [name, toRgb(root.getPropertyValue(`--${name}`).trim())])),
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
    navBackground: painted(".bottom-nav", "backgroundColor"),
    mutedColor: painted('.bottom-nav a[href="#calendar"]', "color"),
    accentColor: painted('.bottom-nav a[href="#today"]', "color"),
  };
};

/** One logged-in page at one viewport, with the console errors it produced. */
async function openPage(
  app: TestApp,
  route: string,
  width: number,
  height: number,
  prepare?: (page: Page) => Promise<void>,
  colorScheme?: "light" | "dark",
): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  if (app === undefined) throw new Error("the test app did not boot, so there is no page to open");
  const context = await browser!.newContext({
    viewport: { width, height },
    ...(colorScheme === undefined ? {} : { colorScheme }),
  });
  await context.addCookies([
    { name: SESSION_COOKIE, value: app.cookies.owner, domain: "127.0.0.1", path: "/", httpOnly: true },
  ]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    // Before `goto`: a route or font scale installed later misses the boot it is
    // there for.
    await prepare?.(page);
    // `networkidle` would race the app's own SSE stream, which keeps a request
    // open by design; the rendered heading is the real readiness signal.
    await page.goto(`${app.url}/#${route}`, { waitUntil: "domcontentloaded" });
    await page.locator("main h1").first().waitFor({ timeout: 10_000 });
  } catch (error) {
    // Otherwise a heading timeout leaves the context, and its SSE stream, open
    // until the whole suite ends.
    await context.close();
    throw error;
  }
  return { page, context, errors };
}

test("an unconfigured household's first screen is the mandatory setup page, with no nav, at every phone width", async (t) => {
  if (skipReason !== undefined) return t.skip(skipReason);
  const app = setupFixture;
  if (app === undefined) throw new Error("the test app did not boot, so there is no page to open");
  for (const { width, height, label } of PHONE_WIDTHS) {
    const { page, context, errors } = await openPage(app, "today", width, height);
    try {
      const where = `${label} (${width}px)`;
      // The shell paints a neutral loading screen until the first profile read;
      // the gate's page is what replaces it.
      await page.locator("main h1:has-text('First-run setup')").waitFor({ timeout: 10_000 });
      assert.equal(
        await page.locator(".bottom-nav").count(),
        0,
        `${where}: the gate paints no bottom navigation`,
      );
      assert.equal(
        new URL(page.url()).hash,
        "#/setup",
        `${where}: the address is the setup page's, so a reload or bookmark lands here too`,
      );
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(scrollWidth <= width + 1, `${where}: the setup page scrolls sideways (${scrollWidth}px in ${width}px)`);
      assert.deepEqual(errors, [], `${where}: the screen logged console errors`);
    } finally {
      await context.close();
    }
  }
});

test("the bottom nav fits every phone width, with every tab inside the viewport", async (t) => {
  if (skipReason !== undefined) return t.skip(skipReason);
  const app = homeFixture;
  if (app === undefined) throw new Error("the test app did not boot, so there is no page to open");
  for (const { width, height, label } of PHONE_WIDTHS) {
    const { page, context, errors } = await openPage(app, "today", width, height);
    try {
      await page.locator(".bottom-nav").waitFor({ timeout: 10_000 });
      const geometry = await page.evaluate(NAV_GEOMETRY);
      const where = `${label} (${width}px)`;
      assert.equal(geometry.links.length, 6, `${where}: all six tabs are in the nav`);
      assert.ok(
        geometry.navScrollWidth <= geometry.navClientWidth + 1,
        `${where}: the nav needs ${geometry.navScrollWidth}px but has ${geometry.navClientWidth}px, so a tab is off-screen`,
      );
      for (const link of geometry.links) {
        assert.ok(link.left >= -1, `${where}: the "${link.name}" tab starts at ${link.left}px, off the left edge`);
        assert.ok(
          link.right <= width + 1,
          `${where}: the "${link.name}" tab ends at ${link.right}px, past the ${width}px viewport`,
        );
        assert.ok(
          link.requires <= link.box + 1,
          `${where}: the "${link.name}" label needs ${link.requires}px in a ${link.box}px tab, so it is clipped`,
        );
      }
      assert.ok(
        geometry.documentScrollWidth <= width + 1,
        `${where}: the page scrolls sideways (${geometry.documentScrollWidth}px of content in ${width}px)`,
      );
      assert.deepEqual(errors, [], `${where}: the screen logged console errors`);
    } finally {
      await context.close();
    }
  }
});

test("the short tab label is contained in its accessible name, and the full word survives", async (t) => {
  if (skipReason !== undefined) return t.skip(skipReason);
  const { page, context, errors } = await openPage(homeFixture!, "today", 390, 844);
  try {
    await page.locator(".bottom-nav").waitFor({ timeout: 10_000 });
    const link = page.locator('.bottom-nav a[href="#notifications"]');
    const visible = String(await link.locator(".bottom-nav__label").textContent()).trim();
    const name = String(await link.getAttribute("aria-label"));
    assert.equal(visible, "Alerts", "the narrow label is the shorthand");
    // WCAG 2.5.3 (Label in Name): a speech-input user says what they can see, so
    // the visible text has to be in the accessible name — and the name still has
    // to say which screen this is.
    assert.ok(name.startsWith(visible), `"${visible}" must open the accessible name "${name}"`);
    assert.match(name, /notifications/i, "the full word survives in the accessible name");
    assert.deepEqual(errors, [], "the screen logged console errors");
  } finally {
    await context.close();
  }
});

test("an unread badge does not widen the nav off a narrow phone", async (t) => {
  if (skipReason !== undefined) return t.skip(skipReason);
  // The widest the nav ever gets is the tab with a count beside it: in the flow
  // the badge took the 320 px row to 332 and the sixth tab left the screen, in
  // the one state the tab exists for. The count arrives from the app's own
  // `GET /api/notifications/unread` (web/notifications.js, re-read on every SSE
  // open), so the fixture answers that request instead of poking the store —
  // nothing here races the product's own refresh.
  const { page, context } = await openPage(homeFixture!, "today", 320, 568, async (page) => {
    await page.route("**/api/notifications/unread", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ unread: 3 }) }),
    );
  });
  try {
    await page.locator(".bottom-nav").waitFor({ timeout: 10_000 });
    const link = page.locator('.bottom-nav a[href="#notifications"]');
    await link.locator(".badge--nav").waitFor({ timeout: 5000 });
    const geometry = await page.evaluate(NAV_GEOMETRY);
    assert.ok(
      geometry.navScrollWidth <= geometry.navClientWidth + 1,
      `with an unread badge the nav needs ${geometry.navScrollWidth}px but has ${geometry.navClientWidth}px`,
    );
    assert.equal(await link.locator(".badge--nav").textContent(), "3", "the badge shows the count");
    assert.equal(
      await link.getAttribute("aria-label"),
      "Alerts, notifications, 3 unread",
      "the count reaches a screen reader too, behind the visible label",
    );
    // Out of the flow is not enough on its own: the badge must also clear the
    // label it moved over, which is why it sits above the centred line.
    const clearance = await page.evaluate(() => {
      const link = document.querySelector('.bottom-nav a[href="#notifications"]')!;
      const badge = link.querySelector(".badge--nav")!;
      const text = link.querySelector(".bottom-nav__label")!;
      const label = document.createRange();
      label.selectNodeContents(text);
      const labelBox = label.getBoundingClientRect();
      const badgeBox = badge.getBoundingClientRect();
      return { badgeBottom: Math.round(badgeBox.bottom), labelTop: Math.round(labelBox.top) };
    });
    assert.ok(
      clearance.badgeBottom <= clearance.labelTop,
      `the badge ends at ${clearance.badgeBottom}px but the label starts at ${clearance.labelTop}px, so they overlap`,
    );
  } finally {
    await context.close();
  }
});

test("a user who scales text up still gets every tab on screen", async (t) => {
  if (skipReason !== undefined) return t.skip(skipReason);
  // Android's font size (and a browser's default) multiplies the root font, and
  // the tabs are sized in rem, so the labels grow with it. `min-width: 0` plus
  // `1 1 auto` is what keeps the row inside the viewport: the labels ellipsise,
  // which is a visible loss, but no tab becomes unreachable — the failure this
  // suite exists for. 200% of the 16 px default is the WCAG 1.4.4 floor.
  for (const standard of [18, 20]) {
    const { page, context, errors } = await openPage(homeFixture!, "today", 320, 568, async (page) => {
      const session = await page.context().newCDPSession(page);
      await session.send("Page.setFontSizes", { fontSizes: { standard, fixed: standard - 3 } });
    });
    try {
      await page.locator(".bottom-nav").waitFor({ timeout: 10_000 });
      const geometry = await page.evaluate(NAV_GEOMETRY);
      const where = `320px at a ${standard}px root`;
      const root = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
      assert.equal(root, `${standard}px`, `${where}: the text scale applied`);
      assert.ok(
        geometry.navScrollWidth <= geometry.navClientWidth + 1,
        `${where}: the nav needs ${geometry.navScrollWidth}px but has ${geometry.navClientWidth}px`,
      );
      for (const link of geometry.links) {
        assert.ok(
          link.right <= 320 + 1,
          `${where}: the "${link.name}" tab ends at ${link.right}px, so it is unreachable`,
        );
      }
      assert.deepEqual(errors, [], `${where}: the screen logged console errors`);
    } finally {
      await context.close();
    }
  }
});

test("the system dark scheme repaints the token palette at every phone width", async (t) => {
  if (skipReason !== undefined) return t.skip(skipReason);
  const app = homeFixture;
  if (app === undefined) throw new Error("the test app did not boot, so there is no page to open");
  for (const { width, height, label } of PHONE_WIDTHS) {
    const where = `${label} (${width}px)`;
    const colours = async (scheme: "light" | "dark") => {
      const opened = await openPage(app, "today", width, height, undefined, scheme);
      try {
        // The loading screen's own heading is "Pupkeep", so `openPage`'s wait can
        // end before the today screen (and its nav) exists — wait for the nav
        // the colour assertions read.
        await opened.page.locator(".bottom-nav").waitFor({ timeout: 10_000 });
        return { colours: await opened.page.evaluate(SCHEME_COLORS), errors: [...opened.errors] };
      } finally {
        await opened.context.close();
      }
    };
    const light = await colours("light");
    assert.deepEqual(light.errors, [], `${where}: the light scheme logged console errors`);
    const dark = await colours("dark");
    assert.deepEqual(dark.errors, [], `${where}: the dark scheme logged console errors`);

    assert.equal(light.colours.prefersDark, false, `${where}: the light context does not ask for dark`);
    assert.equal(dark.colours.prefersDark, true, `${where}: the dark context emulates the system scheme`);

    // The override is live: every palette token the app paints with changed.
    for (const name of ["bg", "surface", "ink", "muted", "accent"] as const) {
      assert.notEqual(
        dark.colours.tokens[name],
        light.colours.tokens[name],
        `${where}: --${name} still has the light value in the dark scheme`,
      );
    }

    // And the app is using it: body, nav surface, muted tab and active tab
    // resolve to their tokens in each scheme, not to a hardcoded colour.
    for (const [scheme, seen] of [
      ["light", light.colours],
      ["dark", dark.colours],
    ] as const) {
      assert.equal(seen.bodyBackground, seen.tokens.bg, `${where}: the ${scheme} body paints --bg`);
      assert.equal(seen.bodyColor, seen.tokens.ink, `${where}: the ${scheme} body ink is --ink`);
      assert.equal(seen.navBackground, seen.tokens.surface, `${where}: the ${scheme} nav paints --surface`);
      assert.equal(seen.mutedColor, seen.tokens.muted, `${where}: the ${scheme} muted tab is --muted`);
      assert.equal(seen.accentColor, seen.tokens.accent, `${where}: the ${scheme} active tab is --accent`);
    }

    // The schemes are visibly different, not two names for the same colours.
    assert.notEqual(dark.colours.bodyBackground, light.colours.bodyBackground, `${where}: the body stayed light`);
    assert.notEqual(dark.colours.bodyColor, light.colours.bodyColor, `${where}: the ink stayed light`);
    assert.notEqual(dark.colours.navBackground, light.colours.navBackground, `${where}: the nav stayed light`);
  }
});

test("a completed household's #/setup is Today's address again", async (t) => {
  if (skipReason !== undefined) return t.skip(skipReason);
  const { page, context, errors } = await openPage(homeFixture!, "setup", 390, 844);
  try {
    await page.locator("main h1:has-text('Today')").waitFor({ timeout: 10_000 });
    assert.equal(new URL(page.url()).hash, "#/today", "the setup page's address is Today's once setup is complete");
    assert.equal(await page.locator(".bottom-nav").count(), 1, "the ordinary app's navigation is back");
    assert.deepEqual(errors, [], "the screen logged console errors");
  } finally {
    await context.close();
  }
});

test("every screen paints in a real browser and logs no console error", async (t) => {
  if (skipReason !== undefined) return t.skip(skipReason);
  const { page, context, errors } = await openPage(homeFixture!, "today", 390, 844);
  try {
    await page.locator(".bottom-nav").waitFor({ timeout: 10_000 });
    // The tabs say which screens exist; the table says what each must paint.
    const routes = await page
      .locator(".bottom-nav a")
      .evaluateAll((links) => links.map((link) => (link.getAttribute("href") ?? "").replace(/^#/, "")));
    assert.deepEqual(
      [...routes].sort(),
      Object.keys(SCREENS).sort(),
      "every tab has a heading expectation, and no expectation is for a screen that left the nav",
    );
  } finally {
    await context.close();
  }
  for (const route of Object.keys(SCREENS)) {
    const opened = await openPage(homeFixture!, route, 390, 844);
    try {
      // The loading screen's own heading is "Pupkeep"; wait for the screen the
      // route is for, so the assertion cannot race the first profile read.
      const painted = await opened.page
        .locator("main h1")
        .filter({ hasText: SCREENS[route]! })
        .first()
        .textContent({ timeout: 5000 });
      assert.match(String(painted), SCREENS[route]!, `the ${route} screen painted its heading`);
      assert.deepEqual(opened.errors, [], `the ${route} screen logged console errors`);
    } finally {
      await opened.context.close();
    }
  }
  assert.deepEqual(errors, [], "the first page load logged console errors");
});
