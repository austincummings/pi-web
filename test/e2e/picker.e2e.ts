/**
 * Real-browser (Playwright + system Chrome) tests for <pi-picker>.
 *
 * These complement the happy-dom unit tests (test/pi-picker.test.ts) by
 * exercising what only a real browser gets right: native keydown ordering for
 * the document-level nav loop, real .item hit-testing / click activation, and
 * the backdrop vs card hit-test that drives the close intent. This is the
 * safety net for the <pi-picker> extraction from app.ts.
 */
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
    await page.goto("/picker");
    await page.waitForFunction(() => (window as any).__ready === true);
});

async function events(page: import("@playwright/test").Page) {
    return page.evaluate(() => (window as any).__events);
}

/** Open a nav picker with the given row labels. */
async function openList(
    page: import("@playwright/test").Page,
    labels: string[],
) {
    await page.evaluate((l) => (window as any).openList(l), labels);
}

test("open shows the overlay and preselects the first row", async ({
    page,
}) => {
    await openList(page, ["alpha", "beta", "gamma"]);
    const ov = page.locator("#overlay");
    await expect(ov).toHaveClass(/show/);
    await expect(ov.locator(".item")).toHaveCount(3);
    await expect(ov.locator(".item").nth(0)).toHaveClass(/sel/);
});

test("keyboard nav: Down/End/Home move the highlight and Enter activates", async ({
    page,
}) => {
    await openList(page, ["alpha", "beta", "gamma"]);
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#overlay .item").nth(1)).toHaveClass(/sel/);
    await page.keyboard.press("End");
    await expect(page.locator("#overlay .item").nth(2)).toHaveClass(/sel/);
    await page.keyboard.press("Home");
    await expect(page.locator("#overlay .item").nth(0)).toHaveClass(/sel/);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const click = (await events(page)).find((e: any) => e.name === "row-click");
    expect(click.detail).toEqual({ i: 1, label: "beta" });
});

test("ArrowUp wraps from the first row to the last", async ({ page }) => {
    await openList(page, ["a", "b", "c", "d"]);
    await page.keyboard.press("ArrowUp");
    await expect(page.locator("#overlay .item").nth(3)).toHaveClass(/sel/);
});

test("clicking a row activates it", async ({ page }) => {
    await openList(page, ["one", "two", "three"]);
    await page.locator("#overlay .item", { hasText: "three" }).click();
    const click = (await events(page)).find((e: any) => e.name === "row-click");
    expect(click.detail).toEqual({ i: 2, label: "three" });
});

test("clicking the backdrop emits pi-picker-backdrop; the card does not", async ({
    page,
}) => {
    await openList(page, ["one", "two"]);
    // Click inside the card (the header) — no backdrop intent.
    await page.locator("#overlay .picker h3").click();
    expect(
        (await events(page)).some((e: any) => e.name === "pi-picker-backdrop"),
    ).toBe(false);
    // Click the backdrop near the top edge, away from the centered card.
    await page.locator("#overlay").click({ position: { x: 5, y: 5 } });
    expect(
        (await events(page)).some((e: any) => e.name === "pi-picker-backdrop"),
    ).toBe(true);
});

test("hide() clears .show and the nav loop goes inert", async ({ page }) => {
    await openList(page, ["a", "b", "c"]);
    await page.evaluate(() => (window as any).picker.hide());
    await expect(page.locator("#overlay")).not.toHaveClass(/show/);
    await page.keyboard.press("ArrowDown"); // no visible picker → ignored
    expect((await events(page)).some((e: any) => e.name === "row-click")).toBe(
        false,
    );
});
