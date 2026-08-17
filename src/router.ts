// Message routing: which agent, which session, then delegate to OpenClawClient.
// The agent is whatever the registry says for this Telegram user; there is no
// per-chat selection any more (one Hermes per user).

import type { Logger } from "./logger/logger";
import type { Registry } from "./registry";
import type { OpenClawClient } from "./types";

export type RouteRequest = { userId: number; chatId: number; text: string };
export type RouteResult = { agentId: string; reply: string };

export class RouterError extends Error {
  override name = "RouterError";
}

export class Router {
  constructor(
    private readonly client: OpenClawClient,
    private readonly registry: Registry,
    private readonly logger: Logger,
  ) {}

  /** Stable per-conversation key; OpenClaw scopes it to --agent. */
  buildSessionKey(userId: number, chatId: number): string {
    return `telegram:${userId}:${chatId}`;
  }

  agentFor(userId: number): string {
    const rec = this.registry.findByUserId(userId);
    if (!rec) throw new RouterError(`no agent registered for user ${userId}`);
    return rec.agentId;
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    const agentId = this.agentFor(req.userId);
    const sessionKey = this.buildSessionKey(req.userId, req.chatId);
    this.logger.debug("router dispatch", { agentId, sessionKey });
    const reply = await this.client.sendMessage({ agentId, message: req.text, sessionKey });
    return { agentId, reply };
  }
}
