import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
    await page.goto("/tool");
    await page.waitForFunction(() => (window as any).__ready === true);
});

test("host-adapted write trees render preview and suppress generic success text", async ({
    page,
}) => {
    await page.evaluate(() => {
        (window as any).applyTool({
            id: "tc-write",
            name: "write",
            status: "start",
            args: {
                path: "/tmp/demo.txt",
                content: Array.from(
                    { length: 12 },
                    (_, i) => `line ${String(i + 1).padStart(2, "0")}`,
                ).join("\n"),
            },
            // Simulates the compiled-host case where pi's collapsed write
            // renderer returns null because keyHint() depends on TUI globals.
            callTreeExpanded: {
                type: "AnsiBlock",
                lines: [
                    "write /tmp/demo.txt",
                    "",
                    ...Array.from(
                        { length: 12 },
                        (_, i) => `line ${String(i + 1).padStart(2, "0")}`,
                    ),
                ],
            },
        });
        (window as any).applyTool({
            id: "tc-write",
            name: "write",
            status: "end",
            result: "Successfully wrote 23 bytes to /tmp/demo.txt",
            resultTree: { type: "Container", children: [] },
            resultTreeExpanded: { type: "Container", children: [] },
        });
    });

    const tool = page.locator("pi-tool");
    await expect(tool).toHaveClass(/tool/);
    await expect(tool.locator(".tool-name")).toHaveText("write");
    await expect(tool.locator(".tool-args")).toHaveText("/tmp/demo.txt");
    await expect(tool.locator(".tool-body")).toHaveCount(0);
    await expect(tool.locator(".ansi")).not.toContainText(
        "write /tmp/demo.txt",
    );
    await expect(tool.locator(".ansi")).toContainText("line 01");
    await expect(tool.locator(".ansi")).toContainText("line 10");
    await expect(tool.locator(".ansi")).not.toContainText("line 11");
    await expect(tool.locator(".ansi")).toContainText(
        "... (2 more lines, 12 total, alt+o to expand)",
    );
    await expect(tool).not.toContainText("Successfully wrote");
});

test("host-adapted ls result tree renders first 20 lines and suppresses generic body", async ({
    page,
}) => {
    await page.evaluate(() => {
        const lines = Array.from({ length: 22 }, (_, i) => `entry-${i + 1}`);
        (window as any).applyTool({
            id: "tc-ls",
            name: "ls",
            status: "start",
            args: { path: "." },
        });
        (window as any).applyTool({
            id: "tc-ls",
            name: "ls",
            status: "end",
            result: lines.join("\n"),
            resultTreeExpanded: {
                type: "AnsiBlock",
                lines: ["", ...lines],
            },
        });
    });

    const tool = page.locator("pi-tool");
    await expect(tool.locator(".tool-name")).toHaveText("ls");
    await expect(tool.locator(".tool-args")).toHaveText(".");
    await expect(tool.locator(".tool-body")).toHaveCount(0);
    await expect(tool.locator(".ansi")).toContainText("entry-1");
    await expect(tool.locator(".ansi")).toContainText("entry-20");
    await expect(tool.locator(".ansi")).not.toContainText("entry-21");
    await expect(tool.locator(".ansi")).toContainText(
        "... (2 more lines, alt+o to expand)",
    );
});
