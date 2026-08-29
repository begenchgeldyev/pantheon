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
import { godName, markdownToTelegram, splitMessage } from "./telegram";
import type { OpenClawClient } from "./types";

/** Constant-time secret comparison so a wrong header leaks no timing signal. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function resolveNotifyTarget(body: unknown, registry: Registry, config: Config):
  | { ok: true; chatId: number; agentId: string; text: string }
  | { ok: false; status: 400 | 404; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, status: 400, reason: "bad json" };
  const b = body as { agentId?: unknown; text?: unknown };
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) return { ok: false, status: 400, reason: "text required" };
  const agentId = typeof b.agentId === "string" && b.agentId ? b.agentId : MAIN_AGENT_ID;

  // A user's own agent (main for the owner, u_<id> for others) resolves directly.
  const user = registry.findByAgentId(agentId);
  if (user) return { ok: true, chatId: user.chatId, agentId, text };

  // Extra owner gods (e.g. athena) have no users row of their own; their pushes
  // go to the owner's chat — the same chat that owns agent `main`.
  if (config.ownerGods.includes(agentId)) {
    const owner = registry.findByAgentId(MAIN_AGENT_ID);
    if (owner) return { ok: true, chatId: owner.chatId, agentId, text };
  }
  return { ok: false, status: 404, reason: `unknown agent: ${agentId}` };
}

const TELL_TEXT_MAX = 1500;
const AGENT_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Validate a god-to-god /tell request. Membership is the privacy wall: both
 * ids must belong to the owner's pantheon (main, the router, the owner gods) —
 * u_* agents are other people's gods and are never reachable.
 */
export function resolveTellRequest(body: unknown, registry: Registry, config: Config):
  | { ok: true; from: string; to: string; text: string; ownerChatId: number; ownerUserId: number }
  | { ok: false; status: 400 | 404 | 409; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, status: 400, reason: "bad json" };
  const b = body as { from?: unknown; to?: unknown; text?: unknown };
  if (typeof b.from !== "string" || typeof b.to !== "string" || typeof b.text !== "string") {
    return { ok: false, status: 400, reason: "from, to and text required" };
  }
  const text = b.text.trim();
  if (!text) return { ok: false, status: 400, reason: "text required" };
  if (text.length > TELL_TEXT_MAX) return { ok: false, status: 400, reason: `text too long (max ${TELL_TEXT_MAX})` };
  if (!AGENT_ID_RE.test(b.from) || !AGENT_ID_RE.test(b.to)) {
    return { ok: false, status: 404, reason: "unknown god" };
  }
  if (b.from === b.to) return { ok: false, status: 400, reason: "a god does not send word to itself" };

  const pantheon = new Set([MAIN_AGENT_ID, ...(config.routerAgent ? [config.routerAgent] : []), ...config.ownerGods]);
  if (!pantheon.has(b.from) || !pantheon.has(b.to)) {
    return { ok: false, status: 404, reason: "unknown god" };
  }

  const owner = registry.findByAgentId(MAIN_AGENT_ID);
  if (!owner) return { ok: false, status: 409, reason: "owner not registered yet" };
  return { ok: true, from: b.from, to: b.to, text, ownerChatId: owner.chatId, ownerUserId: owner.tgUserId };
}

const TELL_RATE_LIMIT = 10;
const TELL_RATE_WINDOW_MS = 60_000;

type TellDeps = {
  config: Config;
  registry: Registry;
  logger: Logger;
  client: OpenClawClient;
  send: (chatId: number, text: string) => Promise<void>;
};

/**
 * God-to-god word: validate, run one turn on the target god (in the owner's
 * session with it), relay the target's one-line acknowledgment to the owner.
 * While a god's tell-turn runs, tells FROM that god are refused — an A→B→A
 * chain dies at one hop no matter what the prompt says.
 */
export function makeTellHandler(deps: TellDeps) {
  const inFlight = new Set<string>();
  const stamps: number[] = [];
  return async (body: unknown): Promise<{ status: number; reason?: string }> => {
    const req = resolveTellRequest(body, deps.registry, deps.config);
    if (req.ok === false) {
      deps.logger.warn("tell rejected", { status: req.status, reason: req.reason });
      return { status: req.status, reason: req.reason };
    }
    if (inFlight.has(req.from)) {
      deps.logger.warn("tell loop refused", { from: req.from, to: req.to });
      return { status: 409, reason: "sender is receiving a tell" };
    }
    const now = Date.now();
    while (stamps.length > 0 && now - stamps[0]! > TELL_RATE_WINDOW_MS) stamps.shift();
    if (stamps.length >= TELL_RATE_LIMIT) {
      deps.logger.warn("tell rate capped", { from: req.from, to: req.to });
      return { status: 429, reason: "too many tells" };
    }
    stamps.push(now);

    const frame =
      `[system] Word arrives from ${godName(req.from)}: "${req.text}". ` +
      `File what matters in your memory, then acknowledge in one line, in your own voice. ` +
      `Do not send word onward in response — replies to gods are not carried.`;
    let reply: string;
    inFlight.add(req.to);
    try {
      reply = await deps.client.sendMessage({
        agentId: req.to,
        message: frame,
        sessionKey: `telegram:${req.ownerUserId}:${req.ownerChatId}`,
      });
    } catch (err) {
      deps.logger.error("tell failed", { from: req.from, to: req.to, error: err instanceof Error ? err.message : String(err) });
      return { status: 502, reason: "the word did not arrive" };
    } finally {
      inFlight.delete(req.to);
    }
    try {
      await deps.send(req.ownerChatId, `${godName(req.to)}: ${reply}`);
    } catch (err) {
      deps.logger.error("tell ack send failed", { from: req.from, to: req.to, error: err instanceof Error ? err.message : String(err) });
      return { status: 502, reason: "word delivered but the acknowledgment failed" };
    }
    deps.logger.info("tell delivered", { from: req.from, to: req.to, chars: req.text.length });
    return { status: 200 };
  };
}

export function createNotifyServer(config: Config, bot: Bot, registry: Registry, logger: Logger, client: OpenClawClient) {
  const send = async (chatId: number, source: string): Promise<void> => {
    for (const chunk of splitMessage(source)) {
      const formatted = markdownToTelegram(chunk);
      try {
        await bot.api.sendMessage(chatId, formatted, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      } catch (err) {
        logger.warn("notify html send failed, retrying as plain text", {
          error: err instanceof Error ? err.message : String(err),
          sample: formatted.slice(0, 120),
        });
        await bot.api.sendMessage(chatId, chunk);
      }
    }
  };

  const handleTell = makeTellHandler({ config, registry, logger, client, send });

  return Bun.serve({
    hostname: config.notifyHost,
    port: config.notifyPort,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || (url.pathname !== "/notify" && url.pathname !== "/tell")) {
        return new Response("not found", { status: 404 });
      }
      if (!secretMatches(req.headers.get("x-pantheon-secret"), config.notifySecret)) {
        logger.warn("notify unauthorized", { path: url.pathname });
        return new Response("unauthorized", { status: 401 });
      }
      let body: unknown;
      try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

      if (url.pathname === "/tell") {
        const res = await handleTell(body);
        return res.status === 200
          ? new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(res.reason ?? "tell failed", { status: res.status });
      }

      const target = resolveNotifyTarget(body, registry, config);
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
