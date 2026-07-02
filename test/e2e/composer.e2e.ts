/**
 * Real-browser (Playwright + system Chrome) tests for <pi-composer>.
 *
 * These complement the happy-dom unit tests (test/pi-composer.test.ts) by
 * exercising behavior only a real browser gets right: the actual caret/selection
 * after typing, the browser's native Enter vs Shift+Enter defaults, real focus,
 * and DOM paint of the highlight backdrop. This is the safety net for wiring
 * <pi-composer> into the live app.
 */
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => (window as any).__ready === true);
    await page.locator("#composer #prompt").click(); // focus the textarea
});

/** Read the recorded CustomEvents from the harness. */
async function events(page: import("@playwright/test").Page) {
    return page.evaluate(() => (window as any).__events);
}

test("typing then Enter emits pi-submit and clears the textarea", async ({
    page,
}) => {
    const ta = page.locator("#composer #prompt");
    await ta.type("ship it");
    await page.keyboard.press("Enter");
    const evs = await events(page);
    const submit = evs.find((e: any) => e.name === "pi-submit");
    expect(submit).toBeTruthy();
    expect(submit.detail.text).toBe("ship it");
    await expect(ta).toHaveValue("");
});

test("Shift+Enter inserts a real newline and does NOT submit", async ({
    page,
}) => {
    const ta = page.locator("#composer #prompt");
    await ta.type("line one");
    await page.keyboard.press("Shift+Enter");
    await ta.type("line two");
    await expect(ta).toHaveValue("line one\nline two");
    const evs = await events(page);
    expect(evs.some((e: any) => e.name === "pi-submit")).toBe(false);
});

test("empty composer does not submit on Enter", async ({ page }) => {
    await page.keyboard.press("Enter");
    const evs = await events(page);
    expect(evs.some((e: any) => e.name === "pi-submit")).toBe(false);
});

test("ArrowUp on the first line recalls the previous submission", async ({
    page,
}) => {
    const ta = page.locator("#composer #prompt");
    await ta.type("remembered");
    await page.keyboard.press("Enter");
    await expect(ta).toHaveValue("");
    await page.keyboard.press("ArrowUp");
    await expect(ta).toHaveValue("remembered");
});

test("multi-line: ArrowUp from a lower line moves the caret, not history", async ({
    page,
}) => {
    const ta = page.locator("#composer #prompt");
    // seed history
    await ta.type("old entry");
    await page.keyboard.press("Enter");
    // now type two lines; caret is on the last line
    await ta.type("first");
    await page.keyboard.press("Shift+Enter");
    await ta.type("second");
    // ArrowUp from the last line should move caret up, NOT recall history
    await page.keyboard.press("ArrowUp");
    await expect(ta).toHaveValue("first\nsecond");
});

test("the highlight backdrop paints markdown tints as you type", async ({
    page,
}) => {
    await page.locator("#composer #prompt").type("hello **world**");
    const backdrop = page.locator("#composer #backdrop");
    await expect(backdrop.locator(".md-strong")).toHaveCount(1);
});

test("pi-input fires with the caret offset on each keystroke", async ({
    page,
}) => {
    await page.locator("#composer #prompt").type("hi");
    const evs = await events(page);
    const inputs = evs.filter((e: any) => e.name === "pi-input");
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.at(-1).detail.text).toBe("hi");
    expect(inputs.at(-1).detail.caret).toBe(2);
});

test("Escape emits pi-escape", async ({ page }) => {
    await page.keyboard.press("Escape");
    const evs = await events(page);
    expect(evs.some((e: any) => e.name === "pi-escape")).toBe(true);
});

test("keyGuard lets the host claim Enter (no submit)", async ({ page }) => {
    await page.evaluate(() => {
        (window as any).composer.keyGuard = (e: KeyboardEvent) =>
            e.key === "Enter";
    });
    await page.locator("#composer #prompt").type("guarded");
    await page.keyboard.press("Enter");
    const evs = await events(page);
    expect(evs.some((e: any) => e.name === "pi-submit")).toBe(false);
});

test("setQueue renders rows; clicking one emits pi-dequeue", async ({
    page,
}) => {
    await page.evaluate(() => (window as any).composer.setQueue(["a", "b"]));
    const rows = page.locator("#composer #queued .queued-item");
    await expect(rows).toHaveCount(2);
    await rows.first().click();
    const evs = await events(page);
    expect(evs.some((e: any) => e.name === "pi-dequeue")).toBe(true);
});

test("addImage renders a chip; remove drops it", async ({ page }) => {
    await page.evaluate(() =>
        (window as any).composer.addImage({
            data: "AAAA",
            mimeType: "image/png",
            url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        }),
    );
    const chip = page.locator("#composer .attach-chip");
    await expect(chip).toHaveCount(1);
    await page.locator("#composer .attach-remove").click();
    await expect(page.locator("#composer .attach-chip")).toHaveCount(0);
});

test("setWorkingConfig hides the glyph with frames:[] and overrides the label", async ({
    page,
}) => {
    await page.evaluate(() => {
        const c = (window as any).composer;
        c.setWorking(true);
        c.setWorkingConfig({ message: "Thinking hard…", frames: [] });
    });
    await expect(page.locator("#composer #working .label")).toHaveText(
        "Thinking hard…",
    );
    await expect(page.locator("#composer #working .spin")).toHaveText("");
});

// ---- real-browser-only behaviors (need a live layout engine) --------------

/** The textarea's rendered height in px (autoGrow writes an inline style). */
async function taHeight(page: import("@playwright/test").Page) {
    return page.locator("#composer #prompt").evaluate((el) => {
        const ta = el as HTMLTextAreaElement;
        return parseFloat(ta.style.height) || ta.getBoundingClientRect().height;
    });
}

test("autoGrow expands the textarea as lines are added", async ({ page }) => {
    const ta = page.locator("#composer #prompt");
    await ta.type("one line");
    const single = await taHeight(page);
    for (let i = 0; i < 5; i++) {
        await page.keyboard.press("Shift+Enter");
        await ta.type(`line ${i}`);
    }
    const many = await taHeight(page);
    expect(many).toBeGreaterThan(single);
});

test("clear() empties the value and shrinks the grown textarea back down", async ({
    page,
}) => {
    const ta = page.locator("#composer #prompt");
    await ta.type("a");
    for (let i = 0; i < 5; i++) {
        await page.keyboard.press("Shift+Enter");
        await ta.type(`row ${i}`);
    }
    const tall = await taHeight(page);
    await page.evaluate(() => (window as any).composer.clear());
    await expect(ta).toHaveValue("");
    const shrunk = await taHeight(page);
    expect(shrunk).toBeLessThan(tall);
});

test("spliceRange refocuses the textarea and places the caret at the splice end", async ({
    page,
}) => {
    // blur the textarea first so we can prove spliceRange restores focus
    await page.locator("#composer #prompt").evaluate((el) => {
        (el as HTMLTextAreaElement).blur();
    });
    const caret = await page.evaluate(() => {
        const c = (window as any).composer;
        c.value = "read @src/ab";
        c.spliceRange(5, 12, "src/app.ts "); // @ at index 5
        return c.getCaret();
    });
    expect(caret).toBe("read src/app.ts ".length);
    const focused = await page.evaluate(
        () =>
            document.activeElement ===
            document.querySelector("#composer #prompt"),
    );
    expect(focused).toBe(true);
    await expect(page.locator("#composer #prompt")).toHaveValue(
        "read src/app.ts ",
    );
});

test("history draft round-trip: ArrowUp recalls, ArrowDown restores the draft", async ({
    page,
}) => {
    const ta = page.locator("#composer #prompt");
    await ta.type("remembered");
    await page.keyboard.press("Enter"); // seed history, clears composer
    await expect(ta).toHaveValue("");
    await ta.type("draft in progress");
    await page.keyboard.press("ArrowUp"); // recall the submitted line
    await expect(ta).toHaveValue("remembered");
    await page.keyboard.press("ArrowDown"); // walk back to the stashed draft
    await expect(ta).toHaveValue("draft in progress");
});

test("whitespace-only input does not submit and is left intact", async ({
    page,
}) => {
    const ta = page.locator("#composer #prompt");
    await ta.type("   ");
    await page.keyboard.press("Enter");
    const evs = await events(page);
    expect(evs.some((e: any) => e.name === "pi-submit")).toBe(false);
    await expect(ta).toHaveValue("   ");
});

test("removing the first of two image chips leaves the second", async ({
    page,
}) => {
    await page.evaluate(() => {
        const c = (window as any).composer;
        c.addImage({ data: "A", mimeType: "image/png", url: "img-a" });
        c.addImage({ data: "B", mimeType: "image/png", url: "img-b" });
    });
    await expect(page.locator("#composer .attach-chip")).toHaveCount(2);
    // click the first chip's remove button
    await page.locator("#composer .attach-remove").first().click();
    await expect(page.locator("#composer .attach-chip")).toHaveCount(1);
    const src = await page
        .locator("#composer .attach-chip img")
        .getAttribute("src");
    expect(src).toBe("img-b");
});
