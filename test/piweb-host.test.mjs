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
    const host = createPiWebHost({
        broadcast: (f) => frames.push(f),
        getPi: () => ({}),
    });
    return { host, frames, snap: () => host.snapshot() };
}

test("setWidget with string[] renders a Box of Text rows at the default (aboveEditor->bottom) slot", () => {
    const { host, snap } = makeHost();
    host.setWidget("hello", ["a", "b"]);
    const { docks } = snap();
    expect(docks.bottom.length).toBe(1);
    expect(docks.bottom[0].id).toBe("hello");
    expect(docks.bottom[0].tree).toEqual({
        type: "Box",
        children: [
            { type: "Text", text: "a" },
            { type: "Text", text: "b" },
        ],
    });
});

test("placement maps onto internal rails (belowEditor->footer, left/right pass through)", () => {
    const { host, snap } = makeHost();
    host.setWidget("a", ["x"], { placement: "belowEditor" });
    host.setWidget("b", ["x"], { placement: "left" });
    host.setWidget("c", ["x"], { placement: "right" });
    host.setWidget("d", ["x"], { placement: "aboveEditor" });
    const { docks } = snap();
    expect(docks.footer.map((c) => c.id)).toEqual(["a"]);
    expect(docks.left.map((c) => c.id)).toEqual(["b"]);
    expect(docks.right.map((c) => c.id)).toEqual(["c"]);
    expect(docks.bottom.map((c) => c.id)).toEqual(["d"]);
});

test("title and order options are honored", () => {
    const { host, snap } = makeHost();
    host.setWidget("two", ["x"], { placement: "left", order: 2 });
    host.setWidget("one", ["x"], { placement: "left", order: 1, title: "T" });
    const { docks } = snap();
    expect(docks.left.map((c) => c.id)).toEqual(["one", "two"]);
    expect(docks.left[0].title).toBe("T");
});

test("re-setWidget replaces in place and preserves state unless initialState is given", () => {
    const { host, snap } = makeHost();
    host.setWidget("w", {
        placement: "right",
        initialState: { n: 1 },
        render: (s) => ({ type: "Text", text: `n=${s.n}` }),
        actions: { inc: (ctx) => ctx.setState((s) => ({ n: s.n + 1 })) },
    });
    return host.dispatch("w", "inc").then(() => {
        expect(snap().docks.right[0].tree.text).toBe("n=2");
        // replace render without initialState -> state kept
        host.setWidget("w", {
            placement: "right",
            render: (s) => ({ type: "Text", text: `v=${s.n}` }),
        });
        expect(snap().docks.right[0].tree.text).toBe("v=2");
    });
});

test("setWidget(key, undefined) and removeWidget both remove the widget", () => {
    const { host, snap } = makeHost();
    host.setWidget("a", ["x"]);
    host.setWidget("b", ["x"], { placement: "left" });
    expect(snap().docks.bottom.length + snap().docks.left.length).toBe(2);
    host.setWidget("a", undefined);
    host.removeWidget("b");
    const { docks } = snap();
    expect(docks.bottom.length).toBe(0);
    expect(docks.left.length).toBe(0);
});

test("deprecated dock() alias still mounts (defaults to the right rail)", () => {
    const { host, snap } = makeHost();
    host.dock("legacy", { render: () => ({ type: "Text", text: "hi" }) });
    expect(snap().docks.right.map((c) => c.id)).toEqual(["legacy"]);
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
