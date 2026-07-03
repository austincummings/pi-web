/**
 * Real-browser (Playwright + system Chrome) tests for <pi-dialog>.
 *
 * These complement the happy-dom unit tests (test/pi-dialog.test.ts) by
 * exercising behavior only a real browser gets right: true focus (the OK button
 * / input auto-focus), native keydown ordering for the capture-phase nav,
 * real button/backdrop hit-testing, and DOM paint of the .show backdrop. This
 * is the safety net for wiring <pi-dialog> into the live app.
 */
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
    await page.goto("/dialog");
    await page.waitForFunction(() => (window as any).__ready === true);
});

/** Read the recorded CustomEvents from the harness. */
async function events(page: import("@playwright/test").Page) {
    return page.evaluate(() => (window as any).__events);
}

/** Drive render() imperatively (mirrors the surfaces `dialogs` array). */
async function render(page: import("@playwright/test").Page, dialogs: any[]) {
    await page.evaluate((d) => (window as any).dialog.render(d), dialogs);
}

test("render(select) shows the backdrop and answers on click", async ({
    page,
}) => {
    await render(page, [
        { id: "s1", dialog: "select", title: "Pick one", options: ["a", "b", "c"] },
    ]);
    const dlg = page.locator("#dialog");
    await expect(dlg).toHaveClass(/show/);
    await expect(dlg.locator("h3")).toHaveText("Pick one");
    await dlg.locator(".item", { hasText: "b" }).click();
    const evs = await events(page);
    expect(evs.find((e: any) => e.name === "pi-dialog-open")).toBeTruthy();
    const ans = evs.find((e: any) => e.name === "pi-dialog-answer");
    expect(ans.detail).toEqual({ requestId: "s1", value: "b" });
});

test("select: keyboard nav (ArrowDown x2 + Enter) answers the 3rd option", async ({
    page,
}) => {
    await render(page, [{ id: "s1", dialog: "select", options: ["a", "b", "c"] }]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#dialog .item").nth(2)).toHaveClass(/sel/);
    await page.keyboard.press("Enter");
    const ans = (await events(page)).find((e: any) => e.name === "pi-dialog-answer");
    expect(ans.detail).toEqual({ requestId: "s1", value: "c" });
});

test("confirm: OK button auto-focuses and answers true", async ({ page }) => {
    await render(page, [{ id: "c1", dialog: "confirm", message: "Proceed?" }]);
    // OK is auto-focused, so a bare Enter/Space activates it in a real browser.
    await expect(page.locator("#dialog button.primary")).toBeFocused();
    await page.locator("#dialog button.primary").click();
    const ans = (await events(page)).find((e: any) => e.name === "pi-dialog-answer");
    expect(ans.detail).toEqual({ requestId: "c1", value: true });
});

test("input: field auto-focuses; typing + Enter submits the value", async ({
    page,
}) => {
    await render(page, [{ id: "i1", dialog: "input", placeholder: "name" }]);
    const field = page.locator("#dialog .dialog-field");
    await expect(field).toBeFocused();
    await field.type("hello");
    await page.keyboard.press("Enter");
    const ans = (await events(page)).find((e: any) => e.name === "pi-dialog-answer");
    expect(ans.detail).toEqual({ requestId: "i1", value: "hello" });
});

test("editor: Enter is a newline; Ctrl+Enter saves the multiline value", async ({
    page,
}) => {
    await render(page, [{ id: "e1", dialog: "editor" }]);
    const field = page.locator("#dialog .dialog-field");
    await expect(field).toBeFocused();
    await field.type("one");
    await page.keyboard.press("Enter");
    await field.type("two");
    await expect(field).toHaveValue("one\ntwo");
    expect((await events(page)).some((e: any) => e.name === "pi-dialog-answer")).toBe(
        false,
    );
    await page.keyboard.press("Control+Enter");
    const ans = (await events(page)).find((e: any) => e.name === "pi-dialog-answer");
    expect(ans.detail).toEqual({ requestId: "e1", value: "one\ntwo" });
});

test("Escape cancels: null for input, false for confirm", async ({ page }) => {
    await render(page, [{ id: "i1", dialog: "input" }]);
    await page.keyboard.press("Escape");
    let ans = (await events(page)).find((e: any) => e.name === "pi-dialog-answer");
    expect(ans.detail).toEqual({ requestId: "i1", value: null });

    await render(page, [{ id: "c1", dialog: "confirm", message: "?" }]);
    await page.keyboard.press("Escape");
    ans = (await events(page))
        .filter((e: any) => e.name === "pi-dialog-answer")
        .pop();
    expect(ans.detail).toEqual({ requestId: "c1", value: false });
});

test("clicking the backdrop cancels, but clicking the card does not", async ({
    page,
}) => {
    await render(page, [{ id: "i1", dialog: "input" }]);
    // Click inside the card (the h3 header) — must NOT cancel.
    await page.locator("#dialog .dialog-card h3").click();
    expect((await events(page)).some((e: any) => e.name === "pi-dialog-answer")).toBe(
        false,
    );
    // Click the backdrop near the top edge, away from the centered card.
    await page.locator("#dialog").click({ position: { x: 5, y: 5 } });
    const ans = (await events(page)).find((e: any) => e.name === "pi-dialog-answer");
    expect(ans.detail).toEqual({ requestId: "i1", value: null });
});

test("render([]) hides the backdrop", async ({ page }) => {
    await render(page, [{ id: "s1", dialog: "select", options: ["a"] }]);
    await expect(page.locator("#dialog")).toHaveClass(/show/);
    await render(page, []);
    await expect(page.locator("#dialog")).not.toHaveClass(/show/);
});
