// Shared types for Pantheon.

/** Input for a single OpenClaw agent turn. */
export type SendMessageInput = {
  /** OpenClaw agent id, e.g. "main". */
  agentId: string;
  /** The user's message text. */
  message: string;
  /**
   * Stable key that groups messages into one OpenClaw conversation.
   * OpenClaw owns the actual session state/memory behind this key.
   */
  sessionKey: string;
};

/**
 * Minimal client contract the router depends on. Keeping this as an
 * interface means the router has no knowledge of *how* OpenClaw is reached
 * (CLI today, possibly something else later).
 */
export interface OpenClawClient {
  sendMessage(input: SendMessageInput): Promise<string>;
}
