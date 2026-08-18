// Internal notify endpoint (loopback only). Lets scheduled jobs push messages
// to Telegram. Body: {"agentId": "u_42", "text": "..."}; the agent id is
// resolved to the owning user's chat through the registry. A body without
// agentId is treated as "main" for jobs created before multi-user support.

import { timingSafeEqual } from "node:crypto";
import type { Bot } from "grammy";
import type { Config } from "./config";
import { MAIN_AGENT_ID } from "./constants";
import type { Logger } from "./logger/logger";
import type { Registry } from "./registry";
import { markdownToTelegram, splitMessage } from "./telegram";

/** Constant-time secret comparison so a wrong header leaks no timing signal. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function resolveNotifyTarget(body: unknown, registry: Registry):
  | { ok: true; chatId: number; agentId: string; text: string }
  | { ok: false; status: 400 | 404; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, status: 400, reason: "bad json" };
  const b = body as { agentId?: unknown; text?: unknown };
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) return { ok: false, status: 400, reason: "text required" };
  const agentId = typeof b.agentId === "string" && b.agentId ? b.agentId : MAIN_AGENT_ID;
  const user = registry.findByAgentId(agentId);
  if (!user) return { ok: false, status: 404, reason: `unknown agent: ${agentId}` };
  return { ok: true, chatId: user.chatId, agentId, text };
}

export function createNotifyServer(config: Config, bot: Bot, registry: Registry, logger: Logger) {
  const send = async (chatId: number, source: string): Promise<void> => {
    for (const chunk of splitMessage(source)) {
      const formatted = markdownToTelegram(chunk);
      try {
        await bot.api.sendMessage(chatId, formatted, { parse_mode: "MarkdownV2" });
      } catch (err) {
        logger.warn("notify markdown send failed, retrying as plain text", {
          error: err instanceof Error ? err.message : String(err),
          sample: formatted.slice(0, 120),
        });
        await bot.api.sendMessage(chatId, chunk);
      }
    }
  };

  return Bun.serve({
    hostname: config.notifyHost,
    port: config.notifyPort,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/notify") return new Response("not found", { status: 404 });
      if (!secretMatches(req.headers.get("x-pantheon-secret"), config.notifySecret)) {
        logger.warn("notify unauthorized", { path: url.pathname });
        return new Response("unauthorized", { status: 401 });
      }
      let body: unknown;
      try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

      const target = resolveNotifyTarget(body, registry);
      if (target.ok === false) {
        logger.warn("notify rejected", { status: target.status, reason: target.reason });
        return new Response(target.reason, { status: target.status });
      }
      try {
        await send(target.chatId, target.text);
        logger.info("notify delivered", { agentId: target.agentId, chatId: target.chatId, chars: target.text.length });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      } catch (err) {
        logger.error("notify send failed", { agentId: target.agentId, error: err instanceof Error ? err.message : String(err) });
        return new Response("send failed", { status: 502 });
      }
    },
  });
}
