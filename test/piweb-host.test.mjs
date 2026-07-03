/**
 * Unit tests for the piweb host registry's widget surface API
 * (src/host/piweb-host.ts): `setWidget` placement mapping, `string[]` content
 * synthesis, title/order options, state preservation on replace, and
 * `removeWidget` / `setWidget(key, undefined)` removal.
 */
import { test, expect } from "bun:test";
import { createPiWebHost } from "../src/host/piweb-host.ts";

/** Build a host whose broadcasts are captured, exposing the latest snapshot. */
function makeHost() {
    const frames = [];
    const calls = { footer: 0, header: 0 };
    const host = createPiWebHost({
        broadcast: (f) => frames.push(f),
        getPi: () => ({}),
        requestFooter: () => calls.footer++,
        requestHeader: () => calls.header++,
    });
    return { host, frames, calls, snap: () => host.snapshot() };
}

// ---- setFooter / setHeader (pi-tui ctx.ui.setFooter/setHeader parity) -----

test("setFooter stores the factory, exposes it, and requests a footer rebuild", () => {
    const { host, calls } = makeHost();
    expect(host.getFooterFactory()).toBeUndefined();
    const factory = (data) => ({ type: "Text", text: data.model });
    host.setFooter(factory);
    expect(host.getFooterFactory()).toBe(factory);
    expect(calls.footer).toBe(1);
    // clearing (undefined / non-function) restores the default + rebuilds
    host.setFooter(undefined);
    expect(host.getFooterFactory()).toBeUndefined();
    expect(calls.footer).toBe(2);
});

test("refreshFooter/refreshHeader request a rebuild without changing the factory", () => {
    const { host, calls } = makeHost();
    const f = () => ({ type: "Text", text: "x" });
    host.setFooter(f);
    host.refreshFooter();
    expect(calls.footer).toBe(2); // set + refresh
    expect(host.getFooterFactory()).toBe(f);
    host.refreshHeader();
    expect(calls.header).toBe(1);
});

test("getStatuses returns setStatus segments sorted by key", () => {
    const { host } = makeHost();
    host.setStatus("b", "second");
    host.setStatus("a", "first");
    host.setStatus("c", "third");
    expect(host.getStatuses()).toEqual([
        { key: "a", text: "first" },
        { key: "b", text: "second" },
        { key: "c", text: "third" },
    ]);
});

test("setStatus triggers a footer rebuild only when a footer factory is active", () => {
    const { host, calls } = makeHost();
    host.setStatus("a", "x"); // no factory yet
    expect(calls.footer).toBe(0);
    host.setFooter(() => ({ type: "Text", text: "f" })); // footer:1
    host.setStatus("b", "y"); // footer:2 (statuses can render inline)
    expect(calls.footer).toBe(2);
});

test("setHeader stores + exposes the factory and requests a header rebuild", () => {
    const { host, calls } = makeHost();
    expect(host.getHeaderFactory()).toBeUndefined();
    const factory = () => ({ type: "Text", text: "hdr" });
    host.setHeader(factory);
    expect(host.getHeaderFactory()).toBe(factory);
    expect(calls.header).toBe(1);
});

test("clear() drops footer + header factories and requests rebuilds for each", () => {
    const { host, calls } = makeHost();
    host.setFooter(() => ({ type: "Text", text: "f" })); // footer:1
    host.setHeader(() => ({ type: "Text", text: "h" })); // header:1
    host.clear();
    expect(host.getFooterFactory()).toBeUndefined();
    expect(host.getHeaderFactory()).toBeUndefined();
    expect(calls.footer).toBe(2); // set + clear
    expect(calls.header).toBe(2); // set + clear
});

test("setWidget with string[] renders a Box of Text rows at the default (aboveEditor) slot", () => {
    const { host, snap } = makeHost();
    host.setWidget("hello", ["a", "b"]);
    const { docks } = snap();
    expect(docks.aboveEditor.length).toBe(1);
    expect(docks.aboveEditor[0].id).toBe("hello");
    expect(docks.aboveEditor[0].tree).toEqual({
        type: "Box",
        children: [
            { type: "Text", text: "a" },
            { type: "Text", text: "b" },
        ],
    });
});

test("placement maps onto the two pi-tui slots (aboveEditor default, belowEditor)", () => {
    const { host, snap } = makeHost();
    host.setWidget("a", ["x"], { placement: "belowEditor" });
    host.setWidget("d", ["x"], { placement: "aboveEditor" });
    host.setWidget("e", ["x"]); // default -> aboveEditor
    const { docks } = snap();
    expect(docks.belowEditor.map((c) => c.id)).toEqual(["a"]);
    expect(docks.aboveEditor.map((c) => c.id)).toEqual(["d", "e"]);
});

test("title and order options are honored", () => {
    const { host, snap } = makeHost();
    host.setWidget("two", ["x"], { placement: "aboveEditor", order: 2 });
    host.setWidget("one", ["x"], {
        placement: "aboveEditor",
        order: 1,
        title: "T",
    });
    const { docks } = snap();
    expect(docks.aboveEditor.map((c) => c.id)).toEqual(["one", "two"]);
    expect(docks.aboveEditor[0].title).toBe("T");
});

test("re-setWidget replaces in place and preserves state unless initialState is given", () => {
    const { host, snap } = makeHost();
    host.setWidget("w", {
        placement: "belowEditor",
        initialState: { n: 1 },
        render: (s) => ({ type: "Text", text: `n=${s.n}` }),
        actions: { inc: (ctx) => ctx.setState((s) => ({ n: s.n + 1 })) },
    });
    return host.dispatch("w", "inc").then(() => {
        expect(snap().docks.belowEditor[0].tree.text).toBe("n=2");
        // replace render without initialState -> state kept
        host.setWidget("w", {
            placement: "belowEditor",
            render: (s) => ({ type: "Text", text: `v=${s.n}` }),
        });
        expect(snap().docks.belowEditor[0].tree.text).toBe("v=2");
    });
});

test("setWidget(key, undefined) and removeWidget both remove the widget", () => {
    const { host, snap } = makeHost();
    host.setWidget("a", ["x"]);
    host.setWidget("b", ["x"], { placement: "belowEditor" });
    expect(
        snap().docks.aboveEditor.length + snap().docks.belowEditor.length,
    ).toBe(2);
    host.setWidget("a", undefined);
    host.removeWidget("b");
    const { docks } = snap();
    expect(docks.aboveEditor.length).toBe(0);
    expect(docks.belowEditor.length).toBe(0);
});

test("deprecated dock() alias still mounts (defaults to aboveEditor)", () => {
    const { host, snap } = makeHost();
    host.dock("legacy", { render: () => ({ type: "Text", text: "hi" }) });
    expect(snap().docks.aboveEditor.map((c) => c.id)).toEqual(["legacy"]);
});

// ---- blocking dialogs (select / confirm / input / editor) ----------------

test("select() surfaces a dialog spec and resolves to the chosen option", async () => {
    const { host, snap } = makeHost();
    const p = host.select("Pick one", ["a", "b", "c"]);
    const dialogs = snap().dialogs;
    expect(dialogs.length).toBe(1);
    expect(dialogs[0]).toMatchObject({
        dialog: "select",
        title: "Pick one",
        options: ["a", "b", "c"],
    });
    host.resolveUiRequest(dialogs[0].id, "b");
    expect(await p).toBe("b");
    // resolving clears the pending dialog from the snapshot
    expect(snap().dialogs.length).toBe(0);
});

test("confirm() resolves to a boolean; cancel (non-true) is false", async () => {
    const { host, snap } = makeHost();
    const yes = host.confirm("Title", "Sure?");
    const yId = snap().dialogs[0].id;
    host.resolveUiRequest(yId, true);
    expect(await yes).toBe(true);

    const no = host.confirm("Title", "Sure?");
    const nId = snap().dialogs[0].id;
    host.resolveUiRequest(nId, false);
    expect(await no).toBe(false);
});

test("input()/editor() resolve to the string; null cancels to undefined", async () => {
    const { host, snap } = makeHost();
    const inp = host.input("Name", "type here");
    expect(snap().dialogs[0]).toMatchObject({
        dialog: "input",
        placeholder: "type here",
    });
    host.resolveUiRequest(snap().dialogs[0].id, "hi");
    expect(await inp).toBe("hi");

    const ed = host.editor("Body", "prefill");
    expect(snap().dialogs[0]).toMatchObject({
        dialog: "editor",
        prefill: "prefill",
    });
    host.resolveUiRequest(snap().dialogs[0].id, null);
    expect(await ed).toBeUndefined();
});

test("a timeout auto-dismisses the dialog with undefined", async () => {
    const { host, snap } = makeHost();
    const p = host.input("Q", "", { timeout: 5 });
    expect(snap().dialogs.length).toBe(1);
    expect(await p).toBeUndefined();
    expect(snap().dialogs.length).toBe(0);
});

test("an AbortSignal dismisses the dialog", async () => {
    const { host, snap } = makeHost();
    const ac = new AbortController();
    const p = host.confirm("Q", "?", { signal: ac.signal });
    expect(snap().dialogs.length).toBe(1);
    ac.abort();
    expect(await p).toBe(false);
    expect(snap().dialogs.length).toBe(0);
});

test("clear() cancels open dialogs so awaiting callers unblock", async () => {
    const { host, snap } = makeHost();
    const p = host.select("Pick", ["a"]);
    expect(snap().dialogs.length).toBe(1);
    host.clear();
    expect(await p).toBeUndefined();
    expect(snap().dialogs.length).toBe(0);
});

test("resolveUiRequest with an unknown id is a no-op", () => {
    const { host } = makeHost();
    expect(() => host.resolveUiRequest("nope", "x")).not.toThrow();
});

// ---- custom message renderers (registerMessageRenderer) ------------------

test("registerMessageRenderer + renderMessage return the serialized tree", () => {
    const { host } = makeHost();
    expect(host.hasMessageRenderer("card")).toBe(false);
    host.registerMessageRenderer("card", (msg, opts) => ({
        type: "Text",
        text: `${msg.details.title} (expanded=${opts.expanded})`,
    }));
    expect(host.hasMessageRenderer("card")).toBe(true);
    const tree = host.renderMessage(
        "card",
        { customType: "card", details: { title: "Hi" } },
        { expanded: true },
    );
    expect(tree).toEqual({ type: "Text", text: "Hi (expanded=true)" });
});

test("renderMessage returns null when no renderer is registered", () => {
    const { host } = makeHost();
    expect(host.renderMessage("nope", { customType: "nope" })).toBeNull();
});

test("renderMessage catches a throwing renderer and surfaces a Text node", () => {
    const { host } = makeHost();
    host.registerMessageRenderer("boom", () => {
        throw new Error("kaboom");
    });
    const tree = host.renderMessage("boom", { customType: "boom" });
    expect(tree).toEqual({ type: "Text", text: "render error: kaboom" });
});

test("registerMessageRenderer with a non-function unregisters; clear() drops all", () => {
    const { host } = makeHost();
    host.registerMessageRenderer("x", () => ({ type: "Text", text: "x" }));
    host.registerMessageRenderer("x", null);
    expect(host.hasMessageRenderer("x")).toBe(false);
    host.registerMessageRenderer("y", () => ({ type: "Text", text: "y" }));
    host.clear();
    expect(host.hasMessageRenderer("y")).toBe(false);
});

// ---- custom() (pi-tui ctx.ui.custom parity) -------------------------------

test("custom() mounts an overlay immediately and resolves via done()", async () => {
    const { host, snap } = makeHost();
    let done;
    const p = host.custom((_theme, d) => {
        done = d;
        return { render: () => ({ type: "Text", text: "hi" }) };
    });
    // shown right away (unlike overlay(), which starts hidden)
    expect(snap().overlays.length).toBe(1);
    expect(snap().overlays[0].tree).toEqual({ type: "Text", text: "hi" });
    done("picked");
    await expect(p).resolves.toBe("picked");
    expect(snap().overlays.length).toBe(0); // removed after settling
});

test("custom() resolves through an action handler calling done()", async () => {
    const { host, snap } = makeHost();
    const p = host.custom((_theme, done) => ({
        render: () => ({ type: "Button", label: "OK", action: "ok" }),
        actions: { ok: () => done("ok!") },
    }));
    const id = snap().overlays[0].id;
    await host.dispatch(id, "ok");
    await expect(p).resolves.toBe("ok!");
    expect(snap().overlays.length).toBe(0);
});

test("custom() onHandle.close resolves and removes the surface", async () => {
    const { host, snap } = makeHost();
    let handle;
    const p = host.custom(
        () => ({ render: () => ({ type: "Text", text: "x" }) }),
        { onHandle: (h) => (handle = h) },
    );
    expect(snap().overlays.length).toBe(1);
    handle.close("bye");
    await expect(p).resolves.toBe("bye");
    expect(snap().overlays.length).toBe(0);
});

// ---- setWorking* (pi-tui streaming-indicator overrides) -------------------

test("setWorkingMessage/Visible broadcast working_config + reflect in getWorkingConfig", () => {
    const { host, frames } = makeHost();
    host.setWorkingMessage("Compiling…");
    host.setWorkingVisible(false);
    expect(host.getWorkingConfig()).toEqual({
        message: "Compiling…",
        visible: false,
    });
    const last = frames.at(-1);
    expect(last.kind).toBe("working_config");
    expect(last.config).toEqual({ message: "Compiling…", visible: false });
    // empty/undefined message restores the default (undefined)
    host.setWorkingMessage("");
    expect(host.getWorkingConfig().message).toBeUndefined();
});

test("setWorkingIndicator sets frames/intervalMs; no-arg restores defaults", () => {
    const { host } = makeHost();
    host.setWorkingIndicator({ frames: ["●", "○"], intervalMs: 200 });
    expect(host.getWorkingConfig()).toEqual({
        frames: ["●", "○"],
        intervalMs: 200,
    });
    host.setWorkingIndicator(); // restore default spinner
    expect(host.getWorkingConfig()).toEqual({
        frames: undefined,
        intervalMs: undefined,
    });
    // frames: [] hides the indicator; a non-positive interval is dropped
    host.setWorkingIndicator({ frames: [], intervalMs: 0 });
    expect(host.getWorkingConfig()).toEqual({
        frames: [],
        intervalMs: undefined,
    });
});

// ---- editor-text bridge (pi-tui ui.setEditorText/getEditorText/pasteToEditor) --

test("setEditorText broadcasts an editor set frame and updates the shadow", () => {
    const { host, frames } = makeHost();
    expect(host.getEditorText()).toBe("");
    host.setEditorText("hello world");
    expect(host.getEditorText()).toBe("hello world");
    const f = frames.filter((x) => x.kind === "editor").at(-1);
    expect(f).toEqual({ kind: "editor", op: "set", text: "hello world" });
    // null/undefined normalizes to ""
    host.setEditorText(undefined);
    expect(host.getEditorText()).toBe("");
});

test("pasteToEditor broadcasts a paste frame without touching the shadow", () => {
    const { host, frames } = makeHost();
    host.setEditorText("base");
    host.pasteToEditor("+more");
    const f = frames.filter((x) => x.kind === "editor").at(-1);
    expect(f).toEqual({ kind: "editor", op: "paste", text: "+more" });
    // paste doesn't change the shadow; the client echoes the merged text back
    expect(host.getEditorText()).toBe("base");
    host.updateEditorText("base+more");
    expect(host.getEditorText()).toBe("base+more");
});

// ---- tool-output expansion (pi-tui ui.getToolsExpanded/setToolsExpanded) -----

test("setToolsExpanded broadcasts a tools_expanded frame and reflects state", () => {
    const { host, frames } = makeHost();
    expect(host.getToolsExpanded()).toBe(false);
    host.setToolsExpanded(true);
    expect(host.getToolsExpanded()).toBe(true);
    expect(frames.filter((x) => x.kind === "tools_expanded").at(-1)).toEqual({
        kind: "tools_expanded",
        expanded: true,
    });
    // clear() resets the default + broadcasts collapse
    host.clear();
    expect(host.getToolsExpanded()).toBe(false);
    expect(frames.filter((x) => x.kind === "tools_expanded").at(-1)).toEqual({
        kind: "tools_expanded",
        expanded: false,
    });
});

// ---- mode + theme API (pi-tui ctx.mode / ui.getAllThemes/getTheme/setTheme) --

test("host advertises mode === 'web'", () => {
    const { host } = makeHost();
    expect(host.mode).toBe("web");
});

test("theme API delegates to themeApi (list/get/set) and exposes the shim", () => {
    const frames = [];
    const themes = [
        { name: "dark", path: "/t/dark.json" },
        { name: "light", path: "/t/light.json" },
    ];
    let setArg = null;
    const host = createPiWebHost({
        broadcast: (f) => frames.push(f),
        getPi: () => ({}),
        themeApi: {
            list: () => themes,
            set: (name) => {
                setArg = name;
                return { success: true };
            },
        },
    });
    // theme shim exposes theme.fg(...)
    expect(typeof host.theme.fg).toBe("function");
    expect(host.getAllThemes()).toEqual(themes);
    // getTheme returns the shim for a known name, undefined otherwise
    expect(host.getTheme("dark")).toBe(host.theme);
    expect(host.getTheme("nope")).toBeUndefined();
    // setTheme forwards the name and returns the api result
    expect(host.setTheme("light")).toEqual({ success: true });
    expect(setArg).toBe("light");
    // a Theme-ish object is accepted via its .name
    host.setTheme({ name: "dark" });
    expect(setArg).toBe("dark");
    // empty name is rejected without touching the api
    expect(host.setTheme("")).toEqual({
        success: false,
        error: "no theme name",
    });
});

test("theme API degrades when no themeApi is wired", () => {
    const { host } = makeHost();
    expect(host.getAllThemes()).toEqual([]);
    expect(host.getTheme("dark")).toBeUndefined();
    expect(host.setTheme("dark")).toEqual({
        success: false,
        error: "theme switching unsupported",
    });
});
