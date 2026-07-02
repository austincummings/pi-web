/**
 * Full-host (real app) e2e — boots src/host/server.ts via the Playwright
 * webServer and drives the actual browser UI. This is the acceptance test for
 * wiring <pi-composer> into app.ts: it exercises the risky autocomplete ⇄
 * keydown coupling (the `/` command + `@` file typeaheads, Escape precedence,
 * the highlight backdrop) against the live endpoints.
 *
 * It deliberately never submits a prompt, so no model is ever called — the
 * typeahead reads `/commands` + `/files`, which work without a turn. Runs the
 * same before and after the swap; parity == the swap preserved behavior.
 */
import { test, expect } from "@playwright/test";

// The full host boots on this port (see playwright.config.ts webServer[1]).
const BASE = "http://127.0.0.1:4456";

test.beforeEach(async ({ page }) => {
    await page.goto(BASE + "/");
    // wait for the composer + the SSE handshake (status leaves "connecting…")
    await page.waitForSelector("#prompt");
    await expect(page.locator("#status")).not.toHaveText(/connecting/i, {
        timeout: 15_000,
    });
});

test("the app loads with the composer and the empty-state hint", async ({
    page,
}) => {
    await expect(page.locator("#prompt")).toBeVisible();
    await expect(page.locator("#transcript .empty")).toContainText(/ask pi/i);
});

test("typing '/' opens the command typeahead", async ({ page }) => {
    await page.locator("#prompt").click();
    await page.locator("#prompt").type("/");
    await expect(page.locator("#ac")).toHaveClass(/show/);
    // client commands (/resume, /new, /model, …) populate the list
    await expect(page.locator("#ac .opt").first()).toBeVisible();
    await expect(page.locator("#ac")).toContainText("/resume");
});

test("Escape closes the typeahead without clearing the composer", async ({
    page,
}) => {
    await page.locator("#prompt").click();
    await page.locator("#prompt").type("/re");
    await expect(page.locator("#ac")).toHaveClass(/show/);
    await page.keyboard.press("Escape");
    await expect(page.locator("#ac")).not.toHaveClass(/show/);
    await expect(page.locator("#prompt")).toHaveValue("/re");
});

test("'@' file typeahead lists repo files and Tab accepts the path", async ({
    page,
}) => {
    await page.locator("#prompt").click();
    await page.locator("#prompt").type("@package");
    // /files is served from this repo, so package.json shows up
    await expect(page.locator("#ac")).toHaveClass(/show/);
    await expect(page.locator("#ac")).toContainText("package.json", {
        timeout: 10_000,
    });
    await page.keyboard.press("Tab"); // accept in file mode → keep editing
    await expect(page.locator("#prompt")).toHaveValue(/package\.json/);
});

test("the highlight backdrop paints markdown tints in the live app", async ({
    page,
}) => {
    await page.locator("#prompt").click();
    await page.locator("#prompt").type("ship **it**");
    await expect(page.locator("#backdrop .md-strong")).toHaveCount(1);
});

test("Shift+Enter inserts a newline without sending", async ({ page }) => {
    await page.locator("#prompt").click();
    await page.locator("#prompt").type("line one");
    await page.keyboard.press("Shift+Enter");
    await page.locator("#prompt").type("line two");
    await expect(page.locator("#prompt")).toHaveValue("line one\nline two");
    // nothing was sent → no user bubble in the transcript
    await expect(page.locator("#transcript .msg.user")).toHaveCount(0);
});
