import { test, expect } from "bun:test";
import { Router } from "./router";
import type { Config } from "./config";
import type { OpenClawClient, SendMessageInput } from "./types";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    botToken: "x",
    allowedUserId: 1,
    defaultAgent: "iris",
    agents: ["iris", "atlas"],
    openclawBin: "openclaw",
    openclawTimeoutMs: 120000,
    logLevel: "info",
    ...overrides,
  };
}

function recordingClient(): { client: OpenClawClient; calls: SendMessageInput[] } {
  const calls: SendMessageInput[] = [];
  const client: OpenClawClient = {
    async sendMessage(input) {
      calls.push(input);
      return `reply from ${input.agentId}`;
    },
  };
  return { client, calls };
}

test("falls back to the default agent", () => {
  const router = new Router(recordingClient().client, makeConfig());
  expect(router.getSelectedAgent(42)).toBe("iris");
});

test("selects a known agent and rejects unknown ones", () => {
  const router = new Router(recordingClient().client, makeConfig());
  expect(router.selectAgent(42, "atlas")).toBe(true);
  expect(router.getSelectedAgent(42)).toBe("atlas");
  expect(router.selectAgent(42, "ghost")).toBe(false);
  expect(router.getSelectedAgent(42)).toBe("atlas"); // unchanged
});

test("session key is stable per user+chat", () => {
  const router = new Router(recordingClient().client, makeConfig());
  expect(router.buildSessionKey(7, 9)).toBe("telegram:7:9");
});

test("route uses the selected agent", async () => {
  const { client, calls } = recordingClient();
  const router = new Router(client, makeConfig());
  router.selectAgent(9, "atlas");
  const result = await router.route({ userId: 7, chatId: 9, text: "hi" });
  expect(result.agentId).toBe("atlas");
  expect(result.reply).toBe("reply from atlas");
  expect(calls[0]).toEqual({
    agentId: "atlas",
    message: "hi",
    sessionKey: "telegram:7:9",
  });
});

test("overrideAgent routes one message without changing selection", async () => {
  const { client, calls } = recordingClient();
  const router = new Router(client, makeConfig());
  const result = await router.route({
    userId: 7,
    chatId: 9,
    text: "one-shot",
    overrideAgent: "atlas",
  });
  expect(result.agentId).toBe("atlas");
  expect(calls[0]?.agentId).toBe("atlas");
  expect(router.getSelectedAgent(9)).toBe("iris"); // selection untouched
});
