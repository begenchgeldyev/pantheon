import { test, expect } from "bun:test";
import { Router, RouterError } from "./router";
import { Registry } from "./registry";
import { Logger } from "./logger/logger";
import type { OpenClawClient, SendMessageInput } from "./types";

const silentLogger = new Logger({ write: () => {} }, "error");

function recordingClient(): { client: OpenClawClient; calls: SendMessageInput[] } {
  const calls: SendMessageInput[] = [];
  return {
    calls,
    client: { async sendMessage(input) { calls.push(input); return `reply from ${input.agentId}`; } },
  };
}

function registryWith(): Registry {
  const r = new Registry(":memory:");
  r.insert({ tgUserId: 1, username: "begench", chatId: 1, agentId: "main" });
  r.insert({ tgUserId: 42, username: "amina", chatId: 42, agentId: "u_42" });
  return r;
}

test("session key is stable per user+chat", () => {
  const router = new Router(recordingClient().client, registryWith(), silentLogger);
  expect(router.buildSessionKey(7, 9)).toBe("telegram:7:9");
});

test("routes to the user's own agent", async () => {
  const { client, calls } = recordingClient();
  const router = new Router(client, registryWith(), silentLogger);
  const result = await router.route({ userId: 42, chatId: 42, text: "hi" });
  expect(result).toEqual({ agentId: "u_42", reply: "reply from u_42" });
  expect(calls[0]).toEqual({ agentId: "u_42", message: "hi", sessionKey: "telegram:42:42" });
  expect(router.agentFor(1)).toBe("main");
});

test("unregistered user is rejected", async () => {
  const router = new Router(recordingClient().client, registryWith(), silentLogger);
  await expect(router.route({ userId: 99, chatId: 99, text: "hi" })).rejects.toBeInstanceOf(RouterError);
});
