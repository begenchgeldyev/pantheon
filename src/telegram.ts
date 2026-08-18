// Telegram integration (grammY).
//
// Responsibilities: authenticate the user, expose commands, show a typing
// indicator while OpenClaw works, and deliver replies as HTML (converted from
// the agent's Markdown) split to fit Telegram's length limit. All
// OpenClaw/agent logic lives in the Router.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { Bot, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import telegramifyMarkdown from "telegramify-markdown";
import { normalizeUsername, type Config } from "./config";
import { isAllowedDoc, inboxPathFor } from "./documents";
import { godsFor, HERMES_AGENT_ID } from "./gods";
import type { Logger } from "./logger/logger";
import type { Provisioner } from "./provisioner";
import type { Registry, UserRecord } from "./registry";
import type { Router } from "./router";

// Display names for the gods, with their emblems.
const GOD_NAMES: Record<string, string> = { main: "Hermes 🔔", athena: "Athena 🦉", zeus: "Zeus ⚡" };
function godName(agentId: string): string {
  return GOD_NAMES[agentId] ?? agentId.charAt(0).toUpperCase() + agentId.slice(1);
}

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

// OpenClaw emits a sentinel when the agent deliberately stays silent (e.g. in
// reply to a bare acknowledgement). OpenClaw's own channels swallow it; because
// Pantheon forwards the agent's text verbatim, we must recognise it too and
// send nothing instead of leaking the literal token. Matches the exact whole
// message, case-insensitively, after stripping surrounding markdown emphasis —
// the same normalisation OpenClaw uses (`/^NO_REPLY$/iu`).
const SILENT_TOKEN_RE = /^(NO_REPLY|HEARTBEAT_OK)$/iu;

export function isSilentToken(text: string): boolean {
  const stripped = text.replace(/^[\s*_`~]+|[\s*_`~]+$/gu, "").trim();
  return SILENT_TOKEN_RE.test(stripped);
}

// When the agent stays silent, Hermes — the winged messenger — acknowledges
// without speaking: a dove reaction on the user's message rather than a reply.
const SILENT_REACTION = "🕊"; // U+1F54A dove, no variation selector (Telegram's allowed reaction set)

const HELP = [
  "Pantheon — your personal Hermes, a Telegram gateway to OpenClaw.",
  "",
  "Just write to me: dates to remember, reminders to schedule, questions about what's coming up.",
  "",
  "Commands:",
  "/start — check the connection",
  "/help — show this help",
  "/gods — list the gods you may summon",
  "/<god> — summon a god (e.g. /hermes, /athena)",
  "",
  "Send me a file (e.g. your résumé) and it goes to the god you're speaking with.",
].join("\n");

const WELCOME =
  "Hi, I'm Hermes — your own personal assistant for dates and reminders. Tell me what to remember or when to remind you.";

export function createBot(
  config: Config,
  router: Router,
  provisioner: Provisioner,
  registry: Registry,
  logger: Logger,
  /** `botInfo` skips the getMe call at startup; only tests pass it. */
  opts: { botInfo?: UserFromGetMe } = {},
): Bot {
  const bot = new Bot(config.botToken, opts.botInfo ? { botInfo: opts.botInfo } : undefined);

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
    if (registry.findByUserId(from.id)) {
      registry.touch(from.id, username, chatId);
    } else {
      try {
        await withTyping(ctx, () =>
          provisioner.ensureUser({ tgUserId: from.id, username, firstName: from.first_name, chatId }),
        );
      } catch (err) {
        logger.error("provisioning failed", { userId: from.id, error: err instanceof Error ? err.message : String(err) });
        await ctx.reply(USER_ERROR);
        return;
      }
      // The user is provisioned; a failed greeting must not swallow the turn.
      try {
        await ctx.reply(WELCOME);
      } catch (err) {
        logger.warn("welcome message failed", { userId: from.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    await next();
  });

  bot.command("start", (ctx) =>
    ctx.reply(
      `Pantheon is connected and ready.\nNow speaking with: ${godName(
        router.activeAgentFor(ctx.from!.id, ctx.chat!.id),
      )}\nSend /help for commands.`,
    ),
  );
  bot.command("help", (ctx) => ctx.reply(HELP));

  // --- Gods: the owner may summon more than one god and switch between them. ---
  const godsMenu = (user: UserRecord, active: string): string => {
    const gods = godsFor(user, config);
    const lines = gods.map((g) => `${g === active ? "▸" : "·"} ${godName(g)}`).join("\n");
    const hint = gods.length > 1 ? "\n\nSummon one with /<name> (e.g. /athena)." : "";
    return `Gods you may summon:\n${lines}${hint}`;
  };

  bot.command("gods", (ctx) => {
    const user = registry.findByUserId(ctx.from!.id)!;
    return ctx.reply(godsMenu(user, router.activeAgentFor(ctx.from!.id, ctx.chat!.id)));
  });

  // `/hermes [msg]`, `/athena [msg]`, … — select a god (and optionally speak once).
  const summon = (agentId: string) => async (ctx: Context) => {
    const user = registry.findByUserId(ctx.from!.id)!;
    const active = router.activeAgentFor(ctx.from!.id, ctx.chat!.id);
    if (!godsFor(user, config).includes(agentId)) return ctx.reply(godsMenu(user, active));
    registry.setChatSelection(ctx.chat!.id, agentId);
    logger.info("god summoned", { userId: ctx.from!.id, chatId: ctx.chat!.id, agentId });
    const msg = ctx.match ? String(ctx.match).trim() : "";
    if (msg) return handleTurn(ctx, router, logger, msg);
    return ctx.reply(`You now speak with ${godName(agentId)}.`);
  };
  bot.command("hermes", summon(HERMES_AGENT_ID));
  for (const g of config.ownerGods) {
    if (/^[a-z][a-z0-9_]*$/.test(g)) bot.command(g, summon(g));
  }

  // --- Uploaded files land in the active god's workspace inbox. ---
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const name = doc.file_name ?? "file";
    const gate = isAllowedDoc(name, doc.file_size ?? 0);
    if (!gate.ok) return ctx.reply(gate.reason);

    const agentId = router.activeAgentFor(ctx.from!.id, ctx.chat!.id);
    const dest = inboxPathFor(config.openclawStateDir, agentId, name);
    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("telegram returned no file_path");
      const res = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      mkdirSync(path.dirname(dest), { recursive: true });
      await Bun.write(dest, res);
    } catch (err) {
      logger.error("document intake failed", { agentId, error: err instanceof Error ? err.message : String(err) });
      return ctx.reply("⚠️ I couldn't take that file. Please try again.");
    }
    const rel = `inbox/${path.basename(dest)}`;
    logger.info("document stored", { agentId, chatId: ctx.chat!.id, file: rel });
    await handleTurn(
      ctx,
      router,
      logger,
      `[system] The user uploaded a file into your workspace: ${rel} (${doc.mime_type ?? "unknown type"}, ${doc.file_size ?? "?"} bytes). Read it if useful, record what it is in your memory, and acknowledge it in your own voice.`,
    );
  });

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
    if (isSilentToken(result.reply)) {
      // Agent chose silence: react instead of sending the literal sentinel.
      logger.info("silent reply suppressed", { agentId: result.agentId, chatId });
      await ctx.react(SILENT_REACTION).catch((err) =>
        logger.warn("silent reaction failed", { error: err instanceof Error ? err.message : String(err) }),
      );
      return;
    }
    await sendReply(ctx, result.reply, logger);
  } catch (err) {
    logger.error("openclaw request failed", { userId, chatId, durationMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
    await ctx.reply(USER_ERROR);
  }
}
