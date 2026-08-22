import { test, expect } from "bun:test";
import { Registry } from "./registry";

test("insert then find by user id and agent id", () => {
  const r = new Registry(":memory:");
  const u = r.insert({ tgUserId: 7, username: "amina", chatId: 7, agentId: "u_7" });
  expect(u.agentId).toBe("u_7");
  expect(r.findByUserId(7)?.username).toBe("amina");
  expect(r.findByAgentId("u_7")?.tgUserId).toBe(7);
  expect(r.findByUserId(8)).toBeNull();
  expect(r.findByAgentId("u_8")).toBeNull();
});

test("touch updates username, chat and last_seen", async () => {
  const r = new Registry(":memory:");
  const before = r.insert({ tgUserId: 7, username: "amina", chatId: 7, agentId: "u_7" });
  await new Promise((res) => setTimeout(res, 5));
  r.touch(7, "amina_new", 70);
  const after = r.findByUserId(7)!;
  expect(after.username).toBe("amina_new");
  expect(after.chatId).toBe(70);
  expect(after.lastSeen >= before.lastSeen).toBe(true);
});

test("agent id is unique", () => {
  const r = new Registry(":memory:");
  r.insert({ tgUserId: 1, username: "a", chatId: 1, agentId: "main" });
  expect(() => r.insert({ tgUserId: 2, username: "b", chatId: 2, agentId: "main" })).toThrow();
});

import { Registry as Registry2 } from "./registry";

test("chat selection is unset, settable, and updatable", () => {
  const r = new Registry2(":memory:");
  expect(r.getChatSelection(5)).toBeNull();
  r.setChatSelection(5, "athena");
  expect(r.getChatSelection(5)).toBe("athena");
  r.setChatSelection(5, "main");
  expect(r.getChatSelection(5)).toBe("main");
  r.clearChatSelection(5);
  expect(r.getChatSelection(5)).toBeNull();
  r.clearChatSelection(5); // idempotent
});
