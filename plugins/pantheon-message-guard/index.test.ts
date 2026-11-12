import { expect, test } from "bun:test";
import plugin from "./index";

test("registers typed message-only policy; direct and deferred underlying calls veto before executor", async () => {
  let handler: any;
  let options: any;
  plugin.register({ on(name: string, callback: unknown, opts: unknown) {
    expect(name).toBe("before_tool_call");
    expect(handler).toBeUndefined();
    handler = callback;
    options = opts;
  } } as any);
  expect(options.matcher).toEqual(["message"]);
  let effects = 0;
  // This is a caller double, NOT the native hook dispatcher or loop detector.
  async function invoke(toolName: string, params: unknown) {
    const decision = await handler({ toolName, params }, {});
    if (decision?.block) return decision;
    effects++;
    return "executed";
  }
  const fixtures = [
    { route: "direct", underlying: { toolName: "message" } },
    { route: "dispatch_action", underlying: { toolName: "message" } },
  ];
  for (const fixture of fixtures) { // Host resolution is an explicit fixture assumption, not emulated here.
    for (let i = 0; i < 4; i++) {
      expect(await invoke(fixture.underlying.toolName, { action: "send", channel: "telegram", clawhub: { slug: "secret" } }))
        .toEqual({ block: true, blockReason: "clawhub: remove; use a plain Telegram message." });
    }
  }
  expect(effects).toBe(0);
  expect(await invoke("message", { action: "send", channel: "telegram", message: "repaired" })).toBe("executed");
  expect(effects).toBe(1);
  // A throw is deliberately not converted by the plugin to an allow decision.
  const throwingParams = new Proxy({}, { get() { throw new Error("fixture hook failure"); } });
  await expect(invoke("message", throwingParams)).rejects.toThrow("fixture hook failure");
  expect(effects).toBe(1);
});
