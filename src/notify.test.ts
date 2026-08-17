import { test, expect } from "bun:test";
import { resolveNotifyTarget } from "./notify";
import { Registry } from "./registry";

function reg() {
  const r = new Registry(":memory:");
  r.insert({ tgUserId: 1, username: "begench", chatId: 1, agentId: "main" });
  r.insert({ tgUserId: 42, username: "amina", chatId: 42, agentId: "u_42" });
  return r;
}

test("resolves agentId to the user's chat", () => {
  const r = resolveNotifyTarget({ agentId: "u_42", text: "hi" }, reg());
  expect(r).toEqual({ ok: true, chatId: 42, agentId: "u_42", text: "hi" });
});

test("missing agentId falls back to main (legacy jobs)", () => {
  const r = resolveNotifyTarget({ text: "old job" }, reg());
  expect(r).toEqual({ ok: true, chatId: 1, agentId: "main", text: "old job" });
});

test("unknown agent -> 404, missing text -> 400", () => {
  expect(resolveNotifyTarget({ agentId: "u_999", text: "x" }, reg())).toMatchObject({ ok: false, status: 404 });
  expect(resolveNotifyTarget({ agentId: "u_42", text: "  " }, reg())).toMatchObject({ ok: false, status: 400 });
  expect(resolveNotifyTarget(null, reg())).toMatchObject({ ok: false, status: 400 });
});
