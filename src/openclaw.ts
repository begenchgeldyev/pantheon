// OpenClaw CLI adapter.
//
// This is the ONLY module that knows how to talk to OpenClaw. It shells out
// to the official CLI:
//
//   openclaw agent --agent <id> --session-key <key> --message <text> --json
//
// Security: we invoke the binary via Bun.spawn() with an argument ARRAY, never
// a shell string. Telegram-supplied text is passed as a single argv element,
// so it cannot be interpreted as flags, redirection, or additional commands.

import type { Config } from "./config";
import type { Logger } from "./logger/logger";
import type { OpenClawClient, SendMessageInput } from "./types";

export class OpenClawError extends Error {
  override name = "OpenClawError";
  constructor(
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Extract the assistant's reply text from OpenClaw's `--json` output.
 *
 * IMPORTANT: The exact JSON shape has not been verified against a live
 * OpenClaw on the VPS yet (this dev machine has no OpenClaw install). We try
 * the field names OpenClaw-style tools commonly use and fail loudly with the
 * observed keys if none match, so this function can be tightened after running:
 *
 *   openclaw agent --agent main --session-key pantheon-test \
 *     --message "Reply with exactly: PANTHEON_OK" --json
 *
 * Keep this the single place that encodes response-shape assumptions.
 */
export function extractResponseText(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OpenClawError("OpenClaw did not return valid JSON", {
      sample: raw.slice(0, 200),
    });
  }

  if (typeof parsed === "string") return parsed;

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;

    // Direct string fields, in rough order of likelihood.
    for (const key of ["response", "text", "message", "content", "reply", "output"]) {
      const value = obj[key];
      if (typeof value === "string" && value.length > 0) return value;
    }

    // Nested under a data/result envelope.
    for (const envelope of ["data", "result"]) {
      const inner = obj[envelope];
      if (inner && typeof inner === "object") {
        const innerObj = inner as Record<string, unknown>;
        for (const key of ["response", "text", "message", "content", "reply"]) {
          const value = innerObj[key];
          if (typeof value === "string" && value.length > 0) return value;
        }

        // OpenClaw shape: result.payloads[0].text
        const payloads = innerObj.payloads;
        if (Array.isArray(payloads)) {
          const chunks: string[] = [];
          for (const p of payloads) {
            const t = (p as Record<string, unknown> | null)?.text;
            if (typeof t === "string" && t.length > 0) chunks.push(t);
          }
          if (chunks.length > 0) return chunks.join("\n\n");
        }

        // Fallback: result.meta.finalAssistantVisibleText
        const meta = innerObj.meta as Record<string, unknown> | undefined;
        const visible = meta?.finalAssistantVisibleText;
        if (typeof visible === "string" && visible.length > 0) return visible;
      }
    }

    // Chat-style: messages array where the last entry holds the reply.
    const messages = obj.messages;
    if (Array.isArray(messages) && messages.length > 0) {
      const last = messages[messages.length - 1] as Record<string, unknown>;
      const value = last?.content ?? last?.text ?? last?.message;
      if (typeof value === "string" && value.length > 0) return value;
    }

    throw new OpenClawError(
      "Could not find reply text in OpenClaw JSON; adjust extractResponseText()",
      { keys: Object.keys(obj) },
    );
  }

  throw new OpenClawError("Unexpected OpenClaw JSON payload type", {
    type: typeof parsed,
  });
}

async function readStream(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

export function createOpenClawClient(config: Config, logger: Logger): OpenClawClient {
  const timeoutSeconds = Math.ceil(config.openclawTimeoutMs / 1000);

  async function sendMessage(input: SendMessageInput): Promise<string> {
    const args = [
      config.openclawBin,
      "agent",
      "--agent",
      input.agentId,
      "--session-key",
      input.sessionKey,
      "--message",
      input.message,
      "--timeout",
      String(timeoutSeconds),
      "--json",
    ];

    const proc = Bun.spawn(args, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, config.openclawTimeoutMs);

    let stdout = "";
    let stderr = "";
    try {
      [stdout, stderr] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
      ]);
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) {
      throw new OpenClawError("OpenClaw call timed out", {
        agentId: input.agentId,
        timeoutMs: config.openclawTimeoutMs,
      });
    }

    if (proc.exitCode !== 0) {
      // stderr may contain useful diagnostics; log server-side only.
      logger.error("openclaw exited non-zero", {
        agentId: input.agentId,
        exitCode: proc.exitCode,
        stderr: stderr.slice(0, 500),
      });
      throw new OpenClawError("OpenClaw returned an error", {
        exitCode: proc.exitCode,
      });
    }

    const text = extractResponseText(stdout).trim();
    if (!text) {
      throw new OpenClawError("OpenClaw returned an empty reply");
    }
    return text;
  }

  return { sendMessage };
}
