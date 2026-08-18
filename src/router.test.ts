import { test, expect } from "bun:test";
import { Router, RouterError } from "./router";
import { Registry } from "./registry";
import { loadConfig } from "./config";
import { Logger } from "./logger/logger";
import type { OpenClawClient, SendMessageInput } from "./types";

const silentLogger = new Logger({ write: () => {} }, "error");

const config = loadConfig({
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_ALLOWED_USERNAMES: "begench,amina",
  TELEGRAM_OWNER_USERNAME: "begench",
  PANTHEON_OWNER_GODS: "athena",
  NOTIFY_SECRET: "s",
});

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
  const router = new Router(recordingClient().client, registryWith(), config, silentLogger);
  expect(router.buildSessionKey(7, 9)).toBe("telegram:7:9");
});

test("routes to the user's own agent by default", async () => {
  const { client, calls } = recordingClient();
  const router = new Router(client, registryWith(), config, silentLogger);
  const result = await router.route({ userId: 42, chatId: 42, text: "hi" });
  expect(result).toEqual({ agentId: "u_42", reply: "reply from u_42" });
  expect(calls[0]).toEqual({ agentId: "u_42", message: "hi", sessionKey: "telegram:42:42" });
  expect(router.activeAgentFor(1, 1)).toBe("main");
});

test("owner's selected god is honoured", async () => {
  const { client, calls } = recordingClient();
  const registry = registryWith();
  registry.setChatSelection(1, "athena");
  const router = new Router(client, registry, config, silentLogger);
  const result = await router.route({ userId: 1, chatId: 1, text: "find work" });
  expect(result.agentId).toBe("athena");
  expect(calls[0]?.agentId).toBe("athena");
});

test("a non-summonable selection falls back to the default god", async () => {
  const registry = registryWith();
  registry.setChatSelection(42, "athena"); // amina may not summon athena
  const router = new Router(recordingClient().client, registry, config, silentLogger);
  expect(router.activeAgentFor(42, 42)).toBe("u_42");
});

test("unregistered user is rejected", async () => {
  const router = new Router(recordingClient().client, registryWith(), config, silentLogger);
  await expect(router.route({ userId: 99, chatId: 99, text: "hi" })).rejects.toBeInstanceOf(RouterError);
});
