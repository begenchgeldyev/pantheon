// Telegram integration (grammY).
//
// Responsibilities: authenticate the user, expose commands, show a typing
// indicator while OpenClaw works, and deliver replies as HTML (converted from
// the agent's Markdown) split to fit Telegram's length limit. All
// OpenClaw/agent logic lives in the Router.

import { Bot, type Context } from "grammy";
import telegramifyMarkdown from "telegramify-markdown";
import { normalizeUsername, type Config } from "./config";
import type { Logger } from "./logger/logger";
import type { Provisioner } from "./provisioner";
import type { Registry } from "./registry";
import type { Router } from "./router";

// Telegram hard limit is 4096 chars; stay just under for safety.
const TELEGRAM_MAX = 4000;

const USER_ERROR = "⚠️ Something went wrong reaching the agent. Please try again.";

// Convert agent Markdown to Telegram MarkdownV2, escaping everything Telegram
// requires escaped so send never fails on stray punctuation.
export function markdownToTelegram(source: string): string {
  return telegramifyMarkdown(source, "escape");
}

/**
 * Split text into Telegram-sized chunks without breaking Unicode code points.
 * Prefers to break at newlines, then spaces, before falling back to a hard cut.
 * Operates on the Markdown source (before HTML conversion) so tags can never
 * straddle a chunk boundary.
 */
export function splitMessage(text: string, max = TELEGRAM_MAX): string[] {
  const points = Array.from(text); // code points, so surrogate pairs stay intact
  if (points.length <= max) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(start + max, points.length);
    if (end < points.length) {
      const window = points.slice(start, end);
      const nl = window.lastIndexOf("\n");
      const sp = window.lastIndexOf(" ");
      const breakAt = nl >= 0 ? nl : sp;
      // Only honour the break if it isn't uselessly early in the chunk.
      if (breakAt > max * 0.5) end = start + breakAt + 1;
    }
    chunks.push(points.slice(start, end).join(""));
    start = end;
  }
  return chunks.map((c) => c.trim()).filter((c) => c.length > 0);
}

/**
 * Send a (possibly long) reply as one or more HTML messages. If Telegram
 * rejects the HTML (rare, but possible if the converter emits something
 * invalid), fall back to plain text so the user still gets the reply.
 */
async function sendReply(ctx: Context, source: string, logger: Logger): Promise<void> {
  for (const chunk of splitMessage(source)) {
    const formatted = markdownToTelegram(chunk);
    try {
      await ctx.reply(formatted, { parse_mode: "MarkdownV2" });
    } catch (err) {
      logger.warn("markdown send failed, retrying as plain text", {
        error: err instanceof Error ? err.message : String(err),
        sample: formatted.slice(0, 120),
      });
      await ctx.reply(chunk);
    }
  }
}

/**
 * Keep a "typing…" indicator alive for the duration of `work`. Telegram's
 * chat action expires after ~5s, so we refresh it.
 */
async function withTyping<T>(ctx: Context, work: () => Promise<T>): Promise<T> {
  const send = () => ctx.replyWithChatAction("typing").catch(() => {});
  await send();
  const interval = setInterval(send, 4000);
  try {
    return await work();
  } finally {
    clearInterval(interval);
  }
}

export function isAllowed(username: string | undefined, allowed: Set<string>): boolean {
  if (!username) return false;
  return allowed.has(normalizeUsername(username));
}

const HELP = [
  "Pantheon — your personal Hermes, a Telegram gateway to OpenClaw.",
  "",
  "Just write to me: dates to remember, reminders to schedule, questions about what's coming up.",
  "",
  "Commands:",
  "/start — check the connection",
  "/help — show this help",
].join("\n");

export function createBot(
  config: Config,
  router: Router,
  provisioner: Provisioner,
  registry: Registry,
  logger: Logger,
): Bot {
  const bot = new Bot(config.botToken);

  // --- Authentication: allow-listed Telegram usernames only. ---
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from || from.is_bot || !isAllowed(from.username, config.allowedUsernames)) {
      logger.warn("rejected unauthorized message", { fromId: from?.id ?? null, username: from?.username ?? null });
      return; // ignore silently
    }
    if (ctx.chat?.type !== "private") return; // no group chats: one user, one agent
    await next();
  });

  // --- Ensure the user has an agent (provisions on first contact). ---
  bot.use(async (ctx, next) => {
    const from = ctx.from!;
    const username = normalizeUsername(from.username!);
    const chatId = ctx.chat!.id;
    try {
      const known = registry.findByUserId(from.id);
      if (known) {
        registry.touch(from.id, username, chatId);
      } else {
        await withTyping(ctx, () =>
          provisioner.ensureUser({ tgUserId: from.id, username, firstName: from.first_name, chatId }),
        );
        await ctx.reply("Hi, I'm Hermes — your own personal assistant for dates and reminders. Tell me what to remember or when to remind you.");
      }
    } catch (err) {
      logger.error("provisioning failed", { userId: from.id, error: err instanceof Error ? err.message : String(err) });
      await ctx.reply(USER_ERROR);
      return;
    }
    await next();
  });

  bot.command("start", (ctx) =>
    ctx.reply(`Pantheon is connected and ready.\nYour agent: ${router.agentFor(ctx.from!.id)}\nSend /help for commands.`),
  );
  bot.command("help", (ctx) => ctx.reply(HELP));

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return ctx.reply("Unknown command. Send /help for the list.");
    await handleTurn(ctx, router, logger, text);
  });

  bot.catch((err) => {
    logger.error("bot handler error", { error: err.error instanceof Error ? err.error.message : String(err.error) });
    err.ctx.reply(USER_ERROR).catch(() => {});
  });

  return bot;
}

async function handleTurn(ctx: Context, router: Router, logger: Logger, text: string): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId === undefined || userId === undefined) return;
  const started = Date.now();
  logger.info("openclaw request started", { userId, chatId });
  try {
    const result = await withTyping(ctx, () => router.route({ userId, chatId, text }));
    logger.info("openclaw response completed", { agentId: result.agentId, chatId, durationMs: Date.now() - started });
    await sendReply(ctx, result.reply, logger);
  } catch (err) {
    logger.error("openclaw request failed", { userId, chatId, durationMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
    await ctx.reply(USER_ERROR);
  }
}
