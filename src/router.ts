// Message routing.
//
// The router decides *which* agent a message goes to and *which* OpenClaw
// session it belongs to, then delegates the actual call to the OpenClawClient.
// Telegram code talks to this module and never touches OpenClaw directly.
//
// Selection state is intentionally in-memory: a Map from chat id -> agent id.
// This is the simplest correct implementation and needs no database because:
//   - OpenClaw owns real conversation memory (keyed by session-key), so a
//     restart never loses history.
//   - The only thing lost on restart is the user's *current agent choice*,
//     which safely falls back to the default agent.
// If multi-process or durable selection is ever needed, this is the single
// place to swap in persistence.

import type { Config } from "./config";
import type { OpenClawClient } from "./types";

export type RouteRequest = {
  userId: number;
  chatId: number;
  text: string;
  /** When set, route this one message to this agent without changing selection. */
  overrideAgent?: string;
};

export type RouteResult = {
  agentId: string;
  reply: string;
};

export class Router {
  private readonly selected = new Map<number, string>();

  constructor(
    private readonly client: OpenClawClient,
    private readonly config: Config,
  ) {}

  listAgents(): string[] {
    return this.config.agents;
  }

  isKnownAgent(name: string): boolean {
    return this.config.agents.includes(name);
  }

  getSelectedAgent(chatId: number): string {
    return this.selected.get(chatId) ?? this.config.defaultAgent;
  }

  /** Select an agent for a chat. Returns false if the agent is unknown. */
  selectAgent(chatId: number, name: string): boolean {
    if (!this.isKnownAgent(name)) return false;
    this.selected.set(chatId, name);
    return true;
  }

  /**
   * Stable per-conversation key. OpenClaw isolates sessions by agent when
   * --agent is supplied, so the key itself does not need the agent id.
   */
  buildSessionKey(userId: number, chatId: number): string {
    return `telegram:${userId}:${chatId}`;
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    const agentId = req.overrideAgent ?? this.getSelectedAgent(req.chatId);
    const sessionKey = this.buildSessionKey(req.userId, req.chatId);
    const reply = await this.client.sendMessage({
      agentId,
      message: req.text,
      sessionKey,
    });
    return { agentId, reply };
  }
}
