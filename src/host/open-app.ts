/**
 * Open a URL in the user's browser as a chromeless "app" window.
 *
 * `--app=<url>` is a Chromium-family flag (Chrome / Chromium / Edge / Brave)
 * that opens a standalone window with no tabs/omnibox — the closest thing to a
 * native app shell for pi-web. We try the known Chromium binaries first and
 * fall back to the platform's default opener (`xdg-open` / `open` / `start`) so
 * the URL still opens *something* even when no Chromium browser is installed.
 */
import { spawn } from "node:child_process";

/** Launch a detached process, resolving true if it spawned without error. */
function launch(cmd: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const child = spawn(cmd, args, {
                detached: true,
                stdio: "ignore",
            });
            child.on("error", () => resolve(false));
            // Give the OS a tick to report ENOENT before we call it a success.
            child.unref();
            setTimeout(() => resolve(true), 150);
        } catch {
            resolve(false);
        }
    });
}

/** Chromium-family executables to probe, in preference order, per platform. */
function chromiumCandidates(): string[] {
    if (process.platform === "darwin") {
        return [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ];
    }
    if (process.platform === "win32") {
        return ["chrome", "msedge", "brave"];
    }
    return [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "brave-browser",
    ];
}

/** Open `url` with the platform's default browser (non-app fallback). */
async function openDefault(url: string): Promise<boolean> {
    if (process.platform === "darwin") return launch("open", [url]);
    if (process.platform === "win32")
        return launch("cmd", ["/c", "start", "", url]);
    return launch("xdg-open", [url]);
}

/**
 * Open `url` as an `--app` window. Returns true once some launcher succeeds.
 * Set `PI_WEB_NO_OPEN=1` to disable auto-opening entirely (headless hosts).
 */
export async function openApp(url: string): Promise<boolean> {
    if (process.env.PI_WEB_NO_OPEN === "1") return false;
    const appArg = `--app=${url}`;
    for (const bin of chromiumCandidates()) {
        if (await launch(bin, [appArg])) return true;
    }
    // No Chromium browser found — at least open the URL normally.
    return openDefault(url);
}

/**
 * Probe whether a pi-web instance is already serving on host:port by hitting
 * its `/health` endpoint. Returns true only for a genuine pi-web response, so a
 * port occupied by something else doesn't trigger the "open existing" path.
 */
export async function probeRunningInstance(
    host: string,
    port: number,
): Promise<boolean> {
    // 0.0.0.0 isn't connectable on every OS — probe loopback instead.
    const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 500);
    try {
        const res = await fetch(`http://${h}:${port}/health`, {
            signal: ctrl.signal,
        });
        if (!res.ok) return false;
        const body: any = await res.json().catch(() => null);
        return !!body && body.ok === true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** Loopback host string suitable for a browser URL (0.0.0.0 → localhost). */
export function browserHost(host: string): string {
    return host === "0.0.0.0" || host === "::" ? "localhost" : host;
}
