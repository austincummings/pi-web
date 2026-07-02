import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the pi-web front-end component tests (test/e2e/*.spec.ts).
 *
 * Uses the system-installed Google Chrome (`channel: "chrome"`) so CI doesn't
 * download Playwright's bundled browsers. The `webServer` boots the static
 * harness (test/e2e/harness-server.ts) that mounts the real bundled
 * `<pi-composer>` — no agent host required, so runs are fast + hermetic.
 *
 * Files are named `*.e2e.ts` (not `*.spec.ts`) so Bun's test runner — which
 * also matches `.spec.` — ignores them; run these with `bun run e2e`.
 */
const PORT = 4399; // component harness (mounts <pi-composer> in isolation)
export const HOST_PORT = 4456; // full pi-web host (real app, no model calls)

export default defineConfig({
    testDir: "./test/e2e",
    testMatch: /.*\.e2e\.ts$/,
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: process.env.CI ? "line" : "list",
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        trace: "on-first-retry",
    },
    projects: [
        {
            name: "chrome",
            use: {
                channel: "chrome",
                headless: true,
                // sandbox is unavailable when the suite runs as root/in CI.
                launchOptions: { args: ["--no-sandbox"] },
            },
        },
    ],
    webServer: [
        {
            command: "bun test/e2e/harness-server.ts",
            url: `http://127.0.0.1:${PORT}`,
            reuseExistingServer: !process.env.CI,
            stdout: "ignore",
            stderr: "pipe",
            env: { HARNESS_PORT: String(PORT) },
        },
        {
            // The real host (src/host/server.ts) for the full-app spec. Boots the
            // agent but the spec never submits a prompt, so no model is called.
            command: "bun start",
            url: `http://127.0.0.1:${HOST_PORT}/health`,
            reuseExistingServer: !process.env.CI,
            timeout: 60_000,
            stdout: "ignore",
            stderr: "pipe",
            env: { PORT: String(HOST_PORT), HOST: "127.0.0.1" },
        },
    ],
});
