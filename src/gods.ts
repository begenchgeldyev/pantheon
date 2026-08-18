// Gods: which agents a user may summon, and which one a chat is talking to.
//
// The owner (the user whose username matches config.ownerUsername) speaks with
// Hermes (`main`) by default and may summon extra gods listed in
// config.ownerGods (e.g. `athena`). Every other user has exactly one god —
// their own provisioned agent — and cannot switch.

import path from "node:path";
import type { Config } from "./config";
import type { UserRecord } from "./registry";

export const HERMES_AGENT_ID = "main";

export function isOwner(user: UserRecord, config: Config): boolean {
  return user.username === config.ownerUsername;
}

/** Agents this user may summon, in display order (first is the default). */
export function godsFor(user: UserRecord, config: Config): string[] {
  if (isOwner(user, config)) return [HERMES_AGENT_ID, ...config.ownerGods];
  return [user.agentId];
}

/**
 * The agent a chat is currently pointed at: the stored selection when it is
 * still one this user may summon, otherwise the user's default god (the first
 * entry of godsFor — `main` for the owner, their own agent for everyone else).
 */
export function activeAgent(user: UserRecord, config: Config, selection: string | null): string {
  const gods = godsFor(user, config);
  if (selection && gods.includes(selection)) return selection;
  return gods[0]!;
}

/** Filesystem workspace for an agent: `main` -> workspace, others -> workspace-<id>. */
export function workspaceDirFor(stateDir: string, agentId: string): string {
  return agentId === HERMES_AGENT_ID
    ? path.join(stateDir, "workspace")
    : path.join(stateDir, `workspace-${agentId}`);
}
