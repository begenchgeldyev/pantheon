// LLM intent classifier for the router.
//
// When the cheap keyword pass (intent.ts) has no opinion, Pantheon asks a
// small, fast model which god a message is for. One short completion per
// message; any failure (network, timeout, unparseable answer) yields null and
// the router falls back to its own defaults. The model never sees anything but
// the message text, the gods' one-line domains and the previous god's id.

import type { GodProfile } from "./gods";

export type IntentClassifier = (
  text: string,
  gods: GodProfile[],
  /** The god that handled the previous message in this chat, if any. */
  previous: string | null,
) => Promise<string | null>;

const GROQ_CHAT_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export type GroqClassifierOptions = {
  /** Overridable for tests. */
  fetchFn?: typeof fetch;
  /** Hard cap per classification; the router must never wait long on this. */
  timeoutMs?: number;
};

export function buildPrompt(text: string, gods: GodProfile[], previous: string | null): string {
  const list = gods.map((g) => `- ${g.id}: ${g.name} — ${g.domain}`).join("\n");
  const prev = previous
    ? `The previous message in this chat was handled by "${previous}". Short follow-ups, answers to its questions, and continuations of that topic belong to it.`
    : "This is the first message in the chat.";
  return [
    "Route this Telegram message to exactly one agent. Agents:",
    list,
    "",
    prev,
    "",
    "Message:",
    text.slice(0, 1500),
    "",
    "Answer with the agent id only.",
  ].join("\n");
}

/** Pick the god id the model named; null if it named none (or several). */
export function parseChoice(answer: string, gods: GodProfile[]): string | null {
  const s = answer.trim().toLowerCase();
  const hits = gods.filter((g) => new RegExp(`(^|[^a-z0-9_])${g.id}([^a-z0-9_]|$)`).test(s));
  return hits.length === 1 ? hits[0]!.id : null;
}

export function createGroqClassifier(apiKey: string, model: string, opts: GroqClassifierOptions = {}): IntentClassifier {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 4000;
  return async (text, gods, previous) => {
    if (gods.length < 2) return null;
    const res = await fetchFn(GROQ_CHAT_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 16,
        // Groq's current small models are reasoning models; without this they
        // spend the whole budget thinking and return an empty answer.
        reasoning_effort: "none",
        messages: [
          {
            role: "system",
            content:
              "You are a message router for a personal assistant made of specialist agents. Reply with the single agent id that should handle the message — nothing else.",
          },
          { role: "user", content: buildPrompt(text, gods, previous) },
        ],
      }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`groq classification failed: ${res.status} ${detail}`);
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const answer = json.choices?.[0]?.message?.content ?? "";
    return parseChoice(answer, gods);
  };
}
