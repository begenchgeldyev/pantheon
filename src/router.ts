// Message routing: which god, which session, then delegate to OpenClawClient.
//
// Non-owner users have exactly one god (their own agent). The owner's messages
// are routed per message:
//   1. a pinned god (set with /<god>, cleared with /auto) always wins;
//   2. otherwise the keyword pass (intent.ts) decides when the signal is clear;
//   3. otherwise the LLM classifier (classifier.ts) decides, knowing which god
//      handled the previous message so follow-ups stay put;
//   4. otherwise stay with the previous god, or the default (the router god,
//      Zeus, when configured — else Hermes).
// Routing decisions are never persisted: only an explicit /<god> pins a chat.

import type { IntentClassifier } from "./classifier";
import type { Config } from "./config";
import { activeAgent, godProfile, godsFor, isOwner } from "./gods";
import { classifyIntent } from "./intent";
import type { Logger } from "./logger/logger";
import type { Registry } from "./registry";
import type { OpenClawClient } from "./types";

const ATHENA_AGENT_ID = "athena";

export type RouteRequest = { userId: number; chatId: number; text: string };
export type RouteResult = { agentId: string; reply: string };
export type RouteMethod = "single" | "pinned" | "keyword" | "llm" | "previous" | "default";

export class RouterError extends Error {
  override name = "RouterError";
}

export class Router {
  /** Last god that handled each chat (owner only). In-memory on purpose. */
  private readonly lastAgent = new Map<number, string>();

  constructor(
    private readonly client: OpenClawClient,
    private readonly registry: Registry,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly classifier: IntentClassifier | null = null,
  ) {}

  /** Stable per-conversation key; OpenClaw scopes it to --agent. */
  buildSessionKey(userId: number, chatId: number): string {
    return `telegram:${userId}:${chatId}`;
  }

  /**
   * The god this chat is currently pointed at: the pinned one, else the last
   * one that answered, else the default. Throws if the user is unknown.
   */
  activeAgentFor(userId: number, chatId: number): string {
    const rec = this.registry.findByUserId(userId);
    if (!rec) throw new RouterError(`no agent registered for user ${userId}`);
    const pinned = this.registry.getChatSelection(chatId);
    if (pinned) return activeAgent(rec, this.config, pinned);
    const last = this.lastAgent.get(chatId);
    if (last && godsFor(rec, this.config).includes(last)) return last;
    return activeAgent(rec, this.config, null);
  }

  /** Decide which god gets this message, and how the decision was made. */
  async chooseAgent(req: RouteRequest): Promise<{ agentId: string; method: RouteMethod }> {
    const rec = this.registry.findByUserId(req.userId);
    if (!rec) throw new RouterError(`no agent registered for user ${req.userId}`);
    const gods = godsFor(rec, this.config);
    if (!isOwner(rec, this.config) || gods.length === 1) return { agentId: gods[0]!, method: "single" };

    const pinned = this.registry.getChatSelection(req.chatId);
    if (pinned && gods.includes(pinned)) return { agentId: pinned, method: "pinned" };

    const athenaId = gods.includes(ATHENA_AGENT_ID) ? ATHENA_AGENT_ID : null;
    const byKeyword = classifyIntent(req.text, athenaId);
    if (byKeyword && gods.includes(byKeyword)) return { agentId: byKeyword, method: "keyword" };

    const previous = this.lastAgent.get(req.chatId) ?? null;
    if (this.classifier) {
      try {
        const byLlm = await this.classifier(req.text, gods.map(godProfile), previous);
        if (byLlm && gods.includes(byLlm)) return { agentId: byLlm, method: "llm" };
      } catch (err) {
        this.logger.warn("intent classifier failed", { chatId: req.chatId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (previous && gods.includes(previous)) return { agentId: previous, method: "previous" };
    return { agentId: gods[0]!, method: "default" };
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    const { agentId, method } = await this.chooseAgent(req);
    this.lastAgent.set(req.chatId, agentId);
    const sessionKey = this.buildSessionKey(req.userId, req.chatId);
    this.logger.info("router dispatch", { agentId, method, chatId: req.chatId });
    this.logger.debug("router session", { agentId, sessionKey });
    const reply = await this.client.sendMessage({ agentId, message: req.text, sessionKey });
    return { agentId, reply };
  }
}
