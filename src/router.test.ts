import { test, expect } from "bun:test";
import { Router, RouterError } from "./router";
import { Registry } from "./registry";
import { loadConfig } from "./config";
import { Logger } from "./logger/logger";
import type { IntentClassifier } from "./classifier";
import type { OpenClawClient, SendMessageInput } from "./types";

const silentLogger = new Logger({ write: () => {} }, "error");

const config = loadConfig({
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_ALLOWED_USERNAMES: "begench,amina",
  TELEGRAM_OWNER_USERNAME: "begench",
  PANTHEON_OWNER_GODS: "athena",
  PANTHEON_ROUTER: "zeus",
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

/** A classifier that answers from a fixed table and records what it was asked. */
function tableClassifier(table: Record<string, string | null>): { classify: IntentClassifier; asked: { text: string; previous: string | null }[] } {
  const asked: { text: string; previous: string | null }[] = [];
  return {
    asked,
    classify: async (text, _gods, previous) => { asked.push({ text, previous }); return table[text] ?? null; },
  };
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
  expect(router.activeAgentFor(1, 1)).toBe("zeus"); // owner cold-start default is the router
});

test("owner's pinned god is honoured and skips all routing", async () => {
  const { client, calls } = recordingClient();
  const registry = registryWith();
  registry.setChatSelection(1, "athena");
  const { classify, asked } = tableClassifier({});
  const router = new Router(client, registry, config, silentLogger, classify);
  const result = await router.route({ userId: 1, chatId: 1, text: "remind me tomorrow" }); // keyword says Hermes
  expect(result.agentId).toBe("athena");
  expect(calls[0]?.agentId).toBe("athena");
  expect(asked).toHaveLength(0);
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

test("keyword routing dispatches per message and does not pin the chat", async () => {
  const registry = registryWith();
  const router = new Router(recordingClient().client, registry, config, silentLogger);
  const r1 = await router.route({ userId: 1, chatId: 1, text: "find me a remote job" });
  expect(r1.agentId).toBe("athena");
  expect(registry.getChatSelection(1)).toBeNull();
  const r2 = await router.route({ userId: 1, chatId: 1, text: "remind me to send it tomorrow" });
  expect(r2.agentId).toBe("main");
  expect(registry.getChatSelection(1)).toBeNull();
});

test("without a classifier, an unclear message stays with the previous god, else the default", async () => {
  const router = new Router(recordingClient().client, registryWith(), config, silentLogger);
  expect((await router.route({ userId: 1, chatId: 1, text: "hey there" })).agentId).toBe("zeus");
  await router.route({ userId: 1, chatId: 1, text: "find me a remote job" });
  expect((await router.route({ userId: 1, chatId: 1, text: "what about the salary?" })).agentId).toBe("athena");
  expect(router.activeAgentFor(1, 1)).toBe("athena");
});

test("LLM classifier routes unclear messages and is told the previous god", async () => {
  const { classify, asked } = tableClassifier({
    "what is the weather tomorrow?": "zeus",
    "and in Novosibirsk?": "zeus",
    "ok add it for 9am": "main",
  });
  const router = new Router(recordingClient().client, registryWith(), config, silentLogger, classify);
  await router.route({ userId: 1, chatId: 1, text: "remind me about laundry at 9pm" }); // keyword → Hermes, LLM not asked
  expect(asked).toHaveLength(0);
  expect((await router.route({ userId: 1, chatId: 1, text: "what is the weather tomorrow?" })).agentId).toBe("zeus");
  expect(asked[0]).toEqual({ text: "what is the weather tomorrow?", previous: "main" });
  expect((await router.route({ userId: 1, chatId: 1, text: "and in Novosibirsk?" })).agentId).toBe("zeus");
  expect(asked[1]?.previous).toBe("zeus");
  expect((await router.route({ userId: 1, chatId: 1, text: "ok add it for 9am" })).agentId).toBe("main");
});

test("classifier answers outside the summonable gods, nulls and errors fall through safely", async () => {
  const flaky: IntentClassifier = async (text) => {
    if (text === "boom") throw new Error("groq down");
    if (text === "stranger") return "apollo";
    return null;
  };
  const router = new Router(recordingClient().client, registryWith(), config, silentLogger, flaky);
  expect((await router.route({ userId: 1, chatId: 1, text: "boom" })).agentId).toBe("zeus");
  await router.route({ userId: 1, chatId: 1, text: "find me a job" }); // → athena
  expect((await router.route({ userId: 1, chatId: 1, text: "stranger" })).agentId).toBe("athena"); // previous
  expect((await router.route({ userId: 1, chatId: 1, text: "meh" })).agentId).toBe("athena"); // previous
});

test("non-owner users are never re-routed by intent or classifier", async () => {
  const { classify, asked } = tableClassifier({ "find me a job": "athena" });
  const router = new Router(recordingClient().client, registryWith(), config, silentLogger, classify);
  const r = await router.route({ userId: 42, chatId: 42, text: "find me a job" });
  expect(r.agentId).toBe("u_42");
  expect(asked).toHaveLength(0);
});
