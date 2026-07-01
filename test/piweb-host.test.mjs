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

test("setWidget with string[] renders a Stack of Text rows at the default (aboveEditor->bottom) slot", () => {
    const { host, snap } = makeHost();
    host.setWidget("hello", ["a", "b"]);
    const { docks } = snap();
    expect(docks.bottom.length).toBe(1);
    expect(docks.bottom[0].id).toBe("hello");
    expect(docks.bottom[0].tree).toEqual({
        type: "Stack",
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
