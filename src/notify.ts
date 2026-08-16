// Internal notify endpoint.
//
// Loopback-only HTTP server that lets scheduled jobs (OpenClaw cron) push
// messages back to Telegram — the outbound half of the gateway. Requires a
// shared secret in the X-Pantheon-Secret header; refuses anything else.
//
//   POST /notify
//   Header: X-Pantheon-Secret: <secret>
//   Body:   {"chatId": 12345, "text": "Anna's birthday is in 7 days"}
//
// Text is rendered through the same Markdown pipeline as user replies, so
// scheduled messages look identical to on-demand ones.

import type { Bot } from "grammy";
import type { Config } from "./config";
import { logger } from "./logger/logger";
import { markdownToTelegram, splitMessage } from "./telegram";

type NotifyPayload = {
  chatId?: number;
  text?: unknown;
};

export function createNotifyServer(config: Config, bot: Bot) {
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
      if (req.method !== "POST" || url.pathname !== "/notify") {
        return new Response("not found", { status: 404 });
      }
      if (req.headers.get("x-pantheon-secret") !== config.notifySecret) {
        logger.warn("notify unauthorized", { path: url.pathname });
        return new Response("unauthorized", { status: 401 });
      }

      let body: NotifyPayload;
      try {
        body = (await req.json()) as NotifyPayload;
      } catch {
        return new Response("bad json", { status: 400 });
      }

      const chatId = typeof body.chatId === "number" ? body.chatId : config.allowedUserId;
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return new Response("text required", { status: 400 });

      try {
        await send(chatId, text);
        logger.info("notify delivered", { chatId, chars: text.length });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        logger.error("notify send failed", {
          chatId,
          error: err instanceof Error ? err.message : String(err),
        });
        return new Response("send failed", { status: 502 });
      }
    },
  });
}
