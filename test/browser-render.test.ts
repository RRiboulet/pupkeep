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
// widths in PLAN §15.4, and assert the two things a layout bug breaks — nothing
// leaves the viewport, and every screen actually paints.
//
// The browser is a devDependency, not a runtime one (the phone never runs it),
// and it is not downloaded by `npm ci`. When the binary is missing this suite
// skips rather than fails, so a fresh container or an offline machine still runs
// the other 800-odd tests; CI installs it (`.github/workflows/ci.yml`) and the
// devcontainer does too (`.devcontainer/postCreate.sh`), which is where the gate
// actually holds.

// The functions handed to `page.evaluate` run in the browser, so they need the
// DOM lib. It is a per-file reference on purpose: `tsconfig.json` sets
// `lib: ["ES2024"]` for the whole project, and pulling DOM globals in there
// would let `src/` compile a `document` reference that the phone's server can
// never resolve.
/// <reference lib="dom" />

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { SESSION_COOKIE } from "../src/server/auth.ts";
import { startTestApp, type TestApp } from "./support/app.ts";

/** The widths PLAN §15.4 has to work at: old and current phones, both platforms. */
const PHONE_WIDTHS = [
  { width: 320, height: 568, label: "iPhone SE (1st gen)" },
  { width: 360, height: 800, label: "small Android" },
  { width: 390, height: 844, label: "iPhone 14" },
  { width: 430, height: 932, label: "iPhone Pro Max" },
] as const;

/** Every screen in `web/app.js`, with the heading it must paint. */
const SCREENS = [
  { route: "today", heading: /First-run setup|Today/ },
  { route: "calendar", heading: /Calendar/ },
  { route: "pup", heading: /Your pup/ },
  { route: "agent", heading: /Agent/ },
  { route: "notifications", heading: /Notifications/ },
  { route: "settings", heading: /Settings/ },
] as const;

const NOT_INSTALLED =
  "no Playwright Chromium is installed, so the render checks are skipped: run `npx playwright install --with-deps chromium`";

let fixture: TestApp | undefined;
let browser: Browser | undefined;
let skipReason: string | undefined;

before(async () => {
  if (!existsSync(chromium.executablePath())) {
    skipReason = NOT_INSTALLED;
    return;
  }
  fixture = await startTestApp({ prefix: "pupkeep-browser-" });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await fixture?.stop();
});

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

/** One logged-in page at one viewport, with the console errors it produced. */
async function openPage(
  route: string,
  width: number,
  height: number,
  prepare?: (page: Page) => Promise<void>,
): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const app = fixture;
  if (app === undefined) throw new Error(NOT_INSTALLED);
  const context = await browser!.newContext({ viewport: { width, height } });
  await context.addCookies([
    { name: SESSION_COOKIE, value: app.cookies.owner, domain: "127.0.0.1", path: "/", httpOnly: true },
  ]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  // Before `goto`: a route installed later misses the boot request it is for.
  await prepare?.(page);
  // `networkidle` would race the app's own SSE stream, which keeps a request
  // open by design; the rendered heading is the real readiness signal.
  await page.goto(`${app.url}/#${route}`, { waitUntil: "domcontentloaded" });
  await page.locator("main h1").first().waitFor({ timeout: 10_000 });
  return { page, context, errors };
}

test("the bottom nav fits every phone width, with every tab inside the viewport", async (t) => {
  if (skipReason !== undefined) return t.skip(skipReason);
  for (const { width, height, label } of PHONE_WIDTHS) {
    const { page, context } = await openPage("today", width, height);
    try {
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
    } finally {
      await context.close();
    }
  }
});

test("the Notifications tab keeps its full accessible name when the visible label is short", async (t) => {
  if (skipReason !== undefined) return t.skip(skipReason);
  const { page, context } = await openPage("today", 390, 844);
  try {
    const name = await page.locator('.bottom-nav a[href="#notifications"]').getAttribute("aria-label");
    // A screen reader must not inherit the shorthand the narrow nav needs.
    assert.match(String(name), /^Notifications/, "the accessible name must still be Notifications");
  } finally {
    await context.close();
  }
});

test("an unread badge does not widen the nav off a narrow phone", async (t) => {
  if (skipReason !== undefined) return t.skip(skipReason);
  // The badge is drawn next to the tab's label, so it is the widest the nav ever
  // gets: in the flow it took the 320 px row from 320 to 332 and the sixth tab
  // left the screen. The count arrives from the app's own
  // `GET /api/notifications/unread` (web/notifications.js, called again on every
  // SSE open), so the fixture answers that request instead of poking the store —
  // nothing here races the product's own refresh.
  const { page, context } = await openPage("today", 320, 700, async (page) => {
    await page.route("**/api/notifications/unread", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ unread: 3 }) }),
    );
  });
  try {
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
      "Notifications, 3 unread",
      "the count reaches a screen reader too",
    );
  } finally {
    await context.close();
  }
});

test("every screen paints in a real browser and logs no console error", async (t) => {
  if (skipReason !== undefined) return t.skip(skipReason);
  for (const { route, heading } of SCREENS) {
    const { page, context, errors } = await openPage(route, 390, 844);
    try {
      const painted = await page.locator("main h1").first().textContent({ timeout: 5000 });
      assert.match(String(painted), heading, `the ${route} screen painted its heading`);
      assert.deepEqual(errors, [], `the ${route} screen logged console errors`);
    } finally {
      await context.close();
    }
  }
});
