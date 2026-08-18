// Message routing: which god, which session, then delegate to OpenClawClient.
//
// A chat talks to its *active* god: the stored per-chat selection when it is
// one the user may summon, otherwise the user's default god (Hermes for the
// owner, their own agent for everyone else). See gods.ts.

import type { Config } from "./config";
import { activeAgent, godsFor, isOwner } from "./gods";
import { classifyIntent } from "./intent";
import type { Logger } from "./logger/logger";
import type { Registry } from "./registry";
import type { OpenClawClient } from "./types";

const ATHENA_AGENT_ID = "athena";

export type RouteRequest = { userId: number; chatId: number; text: string };
export type RouteResult = { agentId: string; reply: string };

export class RouterError extends Error {
  override name = "RouterError";
}

export class Router {
  constructor(
    private readonly client: OpenClawClient,
    private readonly registry: Registry,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  /** Stable per-conversation key; OpenClaw scopes it to --agent. */
  buildSessionKey(userId: number, chatId: number): string {
    return `telegram:${userId}:${chatId}`;
  }

  /** The god this chat is currently talking to. Throws if the user is unknown. */
  activeAgentFor(userId: number, chatId: number): string {
    const rec = this.registry.findByUserId(userId);
    if (!rec) throw new RouterError(`no agent registered for user ${userId}`);
    return activeAgent(rec, this.config, this.registry.getChatSelection(chatId));
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    const rec = this.registry.findByUserId(req.userId);
    if (!rec) throw new RouterError(`no agent registered for user ${req.userId}`);

    let agentId = activeAgent(rec, this.config, this.registry.getChatSelection(req.chatId));

    // Zeus's judgment: for the owner, a message with a clear specialist intent
    // is dispatched to that god and the choice sticks. No clear signal → stay
    // with whichever god the chat is already on (Zeus by default). Non-owner
    // users have a single god and are never re-routed.
    if (isOwner(rec, this.config)) {
      const athenaId = godsFor(rec, this.config).includes(ATHENA_AGENT_ID) ? ATHENA_AGENT_ID : null;
      const intent = classifyIntent(req.text, athenaId);
      if (intent && intent !== agentId) {
        this.registry.setChatSelection(req.chatId, intent);
        this.logger.info("router switched god by intent", { chatId: req.chatId, from: agentId, to: intent });
        agentId = intent;
      }
    }

    const sessionKey = this.buildSessionKey(req.userId, req.chatId);
    this.logger.debug("router dispatch", { agentId, sessionKey });
    const reply = await this.client.sendMessage({ agentId, message: req.text, sessionKey });
    return { agentId, reply };
  }
}
