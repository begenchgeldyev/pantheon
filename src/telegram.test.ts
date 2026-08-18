import { test, expect } from "bun:test";
import type { Update } from "grammy/types";
import { loadConfig } from "./config";
import { Logger } from "./logger/logger";
import type { Provisioner, TelegramIdentity } from "./provisioner";
import { Registry } from "./registry";
import type { Router } from "./router";
import { createBot, isAllowed, splitMessage } from "./telegram";

test("short text is a single chunk", () => {
  expect(splitMessage("hello")).toEqual(["hello"]);
});

test("splits long text within the limit", () => {
  const text = "a".repeat(9000);
  const chunks = splitMessage(text, 4000);
  expect(chunks.length).toBe(3);
  for (const c of chunks) expect(Array.from(c).length).toBeLessThanOrEqual(4000);
  expect(chunks.join("")).toBe(text);
});

test("prefers to break on a newline", () => {
  const text = "x".repeat(3000) + "\n" + "y".repeat(2000);
  const chunks = splitMessage(text, 4000);
  expect(chunks.length).toBe(2);
  expect(chunks[0]).toBe("x".repeat(3000));
  expect(chunks[1]).toBe("y".repeat(2000));
});

test("does not break Unicode code points", () => {
  // Each emoji is a surrogate pair (length 2 in UTF-16, 1 code point).
  const text = "😀".repeat(3000);
  const chunks = splitMessage(text, 1000);
  for (const c of chunks) {
    // A broken surrogate would render as �; ensure none appear.
    expect(c.includes("�")).toBe(false);
  }
  expect(chunks.join("")).toBe(text);
});

test("isAllowed matches case-insensitively and rejects missing usernames", () => {
  const allowed = new Set(["begench", "amina"]);
  expect(isAllowed("Begench", allowed)).toBe(true);
  expect(isAllowed("@amina", allowed)).toBe(true);
  expect(isAllowed("ghost", allowed)).toBe(false);
  expect(isAllowed(undefined, allowed)).toBe(false);
});

// --- Middleware: synthetic updates through a real grammY Bot ---

type ApiCall = { method: string; payload: Record<string, unknown> };

function harness(opts: { failWelcome?: boolean } = {}) {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: "123:fake", TELEGRAM_ALLOWED_USERNAMES: "begench,amina",
    TELEGRAM_OWNER_USERNAME: "begench", NOTIFY_SECRET: "s",
    PANTHEON_OWNER_GODS: "athena", PANTHEON_ROUTER: "zeus", PANTHEON_DATA_DIR: "/tmp/pantheon-test",
  });
  const registry = new Registry(":memory:");
  const ensured: TelegramIdentity[] = [];
  const provisioner = {
    ensureUser: async (id: TelegramIdentity) => {
      ensured.push(id);
      return registry.insert({ tgUserId: id.tgUserId, username: id.username, chatId: id.chatId, agentId: `u_${id.tgUserId}` });
    },
  } as unknown as Provisioner;
  const routed: Array<{ userId: number; chatId: number; text: string }> = [];
  const router = {
    activeAgentFor: (userId: number, chatId: number) => {
      const rec = registry.findByUserId(userId);
      if (!rec) return "unknown";
      const sel = registry.getChatSelection(chatId);
      const gods = rec.username === "begench" ? ["zeus", "main", "athena"] : [rec.agentId];
      return sel && gods.includes(sel) ? sel : gods[0]!;
    },
    route: async (req: { userId: number; chatId: number; text: string }) => {
      routed.push(req);
      const agentId = (registry.findByUserId(req.userId)?.username === "begench")
        ? (registry.getChatSelection(req.chatId) ?? "zeus")
        : `u_${req.userId}`;
      return { agentId, reply: "pong" };
    },
  } as unknown as Router;
  const logs: Array<Record<string, unknown>> = [];
  const logger = new Logger(
    { write: (_severity, line: string) => { logs.push(JSON.parse(line) as Record<string, unknown>); } },
    "debug",
  );

  const bot = createBot(config, router, provisioner, registry, logger, {
    botInfo: {
      id: 1, is_bot: true, first_name: "Pantheon", username: "pantheon_bot",
      can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
      can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
      allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
    },
  });

  const api: ApiCall[] = [];
  let messageId = 0;
  bot.api.config.use(async (_prev, method, payload) => {
    api.push({ method, payload: payload as Record<string, unknown> });
    const text = (payload as { text?: string }).text ?? "";
    if (method === "sendMessage" && opts.failWelcome && text.startsWith("Hi, I'm Hermes")) {
      return { ok: false, error_code: 403, description: "bot was blocked by the user" } as never;
    }
    if (method === "sendMessage") {
      return {
        ok: true,
        result: { message_id: ++messageId, date: 0, chat: { id: 0, type: "private" }, text },
      } as never;
    }
    return { ok: true, result: true } as never;
  });

  // MarkdownV2 conversion adds a trailing newline; compare on the trimmed text.
  const sent = () => api.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text).trim());
  return { bot, registry, ensured, routed, api, sent, logs };
}

function textUpdate(o: { userId: number; username?: string; text: string; chatType?: "private" | "group"; updateId?: number }): Update {
  const chatType = o.chatType ?? "private";
  const entities = o.text.startsWith("/")
    ? [{ type: "bot_command", offset: 0, length: o.text.split(/\s/)[0]!.length }]
    : undefined;
  return {
    update_id: o.updateId ?? o.userId,
    message: {
      message_id: 100 + o.userId, date: 0, text: o.text, ...(entities ? { entities } : {}),
      chat: { id: o.userId, type: chatType, ...(chatType === "private" ? { first_name: "X" } : { title: "G" }) },
      from: { id: o.userId, is_bot: false, first_name: "X", ...(o.username ? { username: o.username } : {}) },
    },
  } as Update;
}

test("an unlisted username is ignored: no provisioning, no reply", async () => {
  const h = harness();
  await h.bot.handleUpdate(textUpdate({ userId: 99, username: "ghost", text: "hello" }));
  expect(h.ensured).toEqual([]);
  expect(h.api).toEqual([]);
  expect(h.routed).toEqual([]);
});

test("an allowed user in a group chat is dropped", async () => {
  const h = harness();
  await h.bot.handleUpdate(textUpdate({ userId: 42, username: "amina", text: "hello", chatType: "group" }));
  expect(h.ensured).toEqual([]);
  expect(h.api).toEqual([]);
  expect(h.routed).toEqual([]);
});

test("an allowed unknown user is provisioned once and welcomed", async () => {
  const h = harness();
  await h.bot.handleUpdate(textUpdate({ userId: 42, username: "Amina", text: "hello" }));
  expect(h.ensured.length).toBe(1);
  expect(h.ensured[0]).toMatchObject({ tgUserId: 42, username: "amina", chatId: 42 });
  expect(h.sent()[0]).toContain("Hi, I'm Hermes");
  expect(h.registry.findByUserId(42)?.agentId).toBe("u_42");
  expect(h.routed).toEqual([{ userId: 42, chatId: 42, text: "hello" }]);
});

test("a known user is not re-provisioned; the registry row is touched and the text routed", async () => {
  const h = harness();
  h.registry.insert({ tgUserId: 42, username: "old-name", chatId: 42, agentId: "u_42" });
  await h.bot.handleUpdate(textUpdate({ userId: 42, username: "amina", text: "what's up" }));
  expect(h.ensured).toEqual([]);
  expect(h.registry.findByUserId(42)?.username).toBe("amina");
  expect(h.routed).toEqual([{ userId: 42, chatId: 42, text: "what's up" }]);
  expect(h.sent()).toEqual(["pong"]);
});

test("a failed welcome message is warned about but does not abort the turn", async () => {
  const h = harness({ failWelcome: true });
  await h.bot.handleUpdate(textUpdate({ userId: 42, username: "amina", text: "hello" }));
  expect(h.ensured.length).toBe(1);
  expect(h.routed).toEqual([{ userId: 42, chatId: 42, text: "hello" }]);
  expect(h.sent()).toContain("pong");
  expect(h.sent().some((t) => t.includes("Something went wrong"))).toBe(false);
  expect(h.logs.some((l) => l.message === "welcome message failed" && l.severity === "warn")).toBe(true);
});

import { isSilentToken } from "./telegram";

test("isSilentToken matches the OpenClaw silent sentinels", () => {
  for (const t of ["NO_REPLY", "no_reply", "  NO_REPLY  ", "*NO_REPLY*", "`NO_REPLY`", "_NO_REPLY_", "HEARTBEAT_OK"]) {
    expect(isSilentToken(t)).toBe(true);
  }
});

test("isSilentToken leaves real replies alone", () => {
  for (const t of ["Got it, thanks", "NO_REPLY needed here", "The answer is NO_REPLY.", "reply", ""]) {
    expect(isSilentToken(t)).toBe(false);
  }
});

import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function docUpdate(o: { userId: number; username: string; fileName: string; fileSize: number; updateId?: number }): Update {
  return {
    update_id: o.updateId ?? o.userId,
    message: {
      message_id: 200 + o.userId, date: 0,
      chat: { id: o.userId, type: "private", first_name: "X" },
      from: { id: o.userId, is_bot: false, first_name: "X", username: o.username },
      document: { file_id: "F", file_unique_id: "U", file_name: o.fileName, file_size: o.fileSize, mime_type: "application/pdf" },
    },
  } as Update;
}

test("owner can list and summon gods; selection is sticky and routes there", async () => {
  const h = harness();
  h.registry.insert({ tgUserId: 1, username: "begench", chatId: 1, agentId: "main" });

  await h.bot.handleUpdate(textUpdate({ userId: 1, username: "begench", text: "/gods" }));
  expect(h.sent().at(-1)).toContain("Athena");

  await h.bot.handleUpdate(textUpdate({ userId: 1, username: "begench", text: "/athena", updateId: 2 }));
  expect(h.registry.getChatSelection(1)).toBe("athena");
  expect(h.sent().at(-1)).toContain("Athena");

  await h.bot.handleUpdate(textUpdate({ userId: 1, username: "begench", text: "find me remote work", updateId: 3 }));
  expect(h.routed.at(-1)).toEqual({ userId: 1, chatId: 1, text: "find me remote work" });
});

test("a non-owner cannot summon athena", async () => {
  const h = harness();
  h.registry.insert({ tgUserId: 42, username: "amina", chatId: 42, agentId: "u_42" });
  await h.bot.handleUpdate(textUpdate({ userId: 42, username: "amina", text: "/athena" }));
  expect(h.registry.getChatSelection(42)).toBeNull();
});

test("an uploaded document lands in the active god's inbox and a turn is dispatched", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "pan-doc-"));
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: "123:fake", TELEGRAM_ALLOWED_USERNAMES: "begench",
    TELEGRAM_OWNER_USERNAME: "begench", PANTHEON_OWNER_GODS: "athena",
    NOTIFY_SECRET: "s", OPENCLAW_STATE_DIR: stateDir, PANTHEON_DATA_DIR: stateDir,
  });
  const registry = new Registry(":memory:");
  registry.insert({ tgUserId: 1, username: "begench", chatId: 1, agentId: "main" });
  registry.setChatSelection(1, "athena");
  const routed: Array<{ text: string; agentId: string }> = [];
  const router = {
    activeAgentFor: () => "athena",
    route: async (req: { userId: number; chatId: number; text: string }) => {
      routed.push({ text: req.text, agentId: "athena" });
      return { agentId: "athena", reply: "" };
    },
  } as unknown as Router;
  const logger = new Logger({ write: () => {} }, "error");
  const provisioner = { ensureUser: async () => registry.findByUserId(1)! } as unknown as Provisioner;
  const bot = createBot(config, router, provisioner, registry, logger, {
    botInfo: {
      id: 1, is_bot: true, first_name: "P", username: "p_bot", can_join_groups: true,
      can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
      has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
      can_manage_bots: false, supports_join_request_queries: false,
    },
  });
  bot.api.config.use(async (_prev, method) => {
    if (method === "getFile") return { ok: true, result: { file_id: "F", file_unique_id: "U", file_path: "documents/cv.pdf" } } as never;
    return { ok: true, result: true } as never;
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("PDFDATA")) as unknown as typeof fetch;
  try {
    await bot.handleUpdate(docUpdate({ userId: 1, username: "begench", fileName: "My CV.pdf", fileSize: 1234 }));
  } finally {
    globalThis.fetch = realFetch;
  }
  const dest = path.join(stateDir, "workspace-athena", "inbox", "My_CV.pdf");
  expect(existsSync(dest)).toBe(true);
  expect(readFileSync(dest, "utf8")).toBe("PDFDATA");
  expect(routed.at(-1)?.text).toContain("inbox/My_CV.pdf");
  rmSync(stateDir, { recursive: true, force: true });
});

test("an oversize document is rejected without writing", async () => {
  const h = harness();
  h.registry.insert({ tgUserId: 1, username: "begench", chatId: 1, agentId: "main" });
  await h.bot.handleUpdate(docUpdate({ userId: 1, username: "begench", fileName: "big.pdf", fileSize: 999_000_000 }));
  expect(h.sent().at(-1)).toContain("too large");
  expect(h.routed).toEqual([]);
});

test("owner can summon the router god (zeus)", async () => {
  const h = harness();
  h.registry.insert({ tgUserId: 1, username: "begench", chatId: 1, agentId: "main" });
  await h.bot.handleUpdate(textUpdate({ userId: 1, username: "begench", text: "/zeus" }));
  expect(h.registry.getChatSelection(1)).toBe("zeus");
  expect(h.sent().at(-1)).toContain("Zeus");
});
