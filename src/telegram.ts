// Telegram integration (grammY).
//
// Responsibilities: authenticate the user, expose commands, show a typing
// indicator while OpenClaw works, and deliver replies as HTML (converted from
// the agent's Markdown) split to fit Telegram's length limit. All
// OpenClaw/agent logic lives in the Router.

import { Bot, type Context } from "grammy";
import telegramifyMarkdown from "telegramify-markdown";
import type { Config } from "./config";
import type { Logger } from "./logger/logger";
import type { Router } from "./router";

// Telegram hard limit is 4096 chars; stay just under for safety.
const TELEGRAM_MAX = 4000;
const AGENT_ID_RE = /^[a-z0-9_]+$/; // valid characters for a Telegram command

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

function agentsList(router: Router): string {
  const lines = router
    .listAgents()
    .map((a) => `• ${a}`)
    .join("\n");
  return `Known agents:\n${lines}`;
}

const HELP = [
  "Pantheon — Telegram gateway to OpenClaw.",
  "",
  "Commands:",
  "/start — check the connection",
  "/help — show this help",
  "/agents — list known agents",
  "/agent <name> — select the active agent",
  "/<agent> <message> — send one message to a specific agent",
  "",
  "Any other message goes to your currently selected agent.",
].join("\n");

export function createBot(config: Config, router: Router, logger: Logger): Bot {
  const bot = new Bot(config.botToken);

  // --- Authentication: allowlist a single numeric user id. ---
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (fromId !== config.allowedUserId) {
      logger.warn("rejected unauthorized message", { fromId: fromId ?? null });
      return; // ignore silently
    }
    logger.info("authorized message received", {
      userId: fromId,
      chatId: ctx.chat?.id,
    });
    await next();
  });

  // --- Static commands ---
  bot.command("start", (ctx) =>
    ctx.reply(
      `Pantheon is connected and ready.\nActive agent: ${router.getSelectedAgent(
        ctx.chat.id,
      )}\nSend /help for commands.`,
    ),
  );

  bot.command("help", (ctx) => ctx.reply(HELP));

  bot.command("agents", (ctx) => ctx.reply(agentsList(router)));

  bot.command("agent", (ctx) => {
    const name = ctx.match.trim();
    if (!name) {
      return ctx.reply(
        `Current agent: ${router.getSelectedAgent(ctx.chat.id)}\n\n${agentsList(router)}`,
      );
    }
    if (!router.selectAgent(ctx.chat.id, name)) {
      return ctx.reply(`Unknown agent: ${name}\n\n${agentsList(router)}`);
    }
    logger.info("selected agent", { chatId: ctx.chat.id, agentId: name });
    return ctx.reply(`Active agent is now: ${name}`);
  });

  // --- One-shot per-agent commands (generated from the agent list) ---
  // e.g. `/hermes remind me ...` routes a single message to hermes without
  // changing the selected agent. Only ids that are valid Telegram commands.
  for (const agentId of router.listAgents()) {
    if (!AGENT_ID_RE.test(agentId)) continue;
    bot.command(agentId, async (ctx) => {
      const text = ctx.match.trim();
      if (!text) {
        // No message: treat as a selection, like /agent <id>.
        router.selectAgent(ctx.chat.id, agentId);
        return ctx.reply(`Active agent is now: ${agentId}`);
      }
      await handleTurn(ctx, router, logger, text, agentId);
    });
  }

  // --- Free-form text ---
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      // Reached here only if no command above matched.
      return ctx.reply("Unknown command. Send /help for the list.");
    }
    await handleTurn(ctx, router, logger, text);
  });

  // --- Centralized error handling ---
  bot.catch((err) => {
    logger.error("bot handler error", {
      error: err.error instanceof Error ? err.error.message : String(err.error),
    });
    err.ctx.reply(USER_ERROR).catch(() => {});
  });

  return bot;
}

/** Run one agent turn: route via OpenClaw and reply. Errors stay server-side. */
async function handleTurn(
  ctx: Context,
  router: Router,
  logger: Logger,
  text: string,
  overrideAgent?: string,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId === undefined || userId === undefined) return;

  const started = Date.now();
  const agentForLog = overrideAgent ?? router.getSelectedAgent(chatId);
  logger.info("openclaw request started", { agentId: agentForLog, chatId });

  try {
    const result = await withTyping(ctx, () =>
      router.route({ userId, chatId, text, overrideAgent }),
    );
    logger.info("openclaw response completed", {
      agentId: result.agentId,
      chatId,
      durationMs: Date.now() - started,
    });
    await sendReply(ctx, result.reply, logger);
  } catch (err) {
    logger.error("openclaw request failed", {
      agentId: agentForLog,
      chatId,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
    await ctx.reply(USER_ERROR);
  }
}
