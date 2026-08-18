import { test, expect } from "bun:test";
import { resolveNotifyTarget } from "./notify";
import { Registry } from "./registry";
import { loadConfig } from "./config";

const config = loadConfig({
  TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ALLOWED_USERNAMES: "begench",
  TELEGRAM_OWNER_USERNAME: "begench", PANTHEON_OWNER_GODS: "athena", NOTIFY_SECRET: "s",
});

function reg() {
  const r = new Registry(":memory:");
  r.insert({ tgUserId: 1, username: "begench", chatId: 1, agentId: "main" });
  r.insert({ tgUserId: 42, username: "amina", chatId: 42, agentId: "u_42" });
  return r;
}

test("resolves agentId to the user's chat", () => {
  expect(resolveNotifyTarget({ agentId: "u_42", text: "hi" }, reg(), config)).toEqual({
    ok: true, chatId: 42, agentId: "u_42", text: "hi",
  });
});

test("missing agentId falls back to main (legacy jobs)", () => {
  expect(resolveNotifyTarget({ text: "old job" }, reg(), config)).toEqual({
    ok: true, chatId: 1, agentId: "main", text: "old job",
  });
});

test("an owner god (athena) pushes to the owner's chat", () => {
  expect(resolveNotifyTarget({ agentId: "athena", text: "new role found" }, reg(), config)).toEqual({
    ok: true, chatId: 1, agentId: "athena", text: "new role found",
  });
});

test("unknown agent -> 404, missing text -> 400", () => {
  expect(resolveNotifyTarget({ agentId: "u_999", text: "x" }, reg(), config)).toMatchObject({ ok: false, status: 404 });
  expect(resolveNotifyTarget({ agentId: "zeus", text: "x" }, reg(), config)).toMatchObject({ ok: false, status: 404 }); // not an owner god
  expect(resolveNotifyTarget({ agentId: "u_42", text: "  " }, reg(), config)).toMatchObject({ ok: false, status: 400 });
  expect(resolveNotifyTarget(null, reg(), config)).toMatchObject({ ok: false, status: 400 });
});
