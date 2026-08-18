// Voice transcription via Groq's Whisper API (OpenAI-compatible endpoint).
//
// Pantheon receives Telegram voice notes (OGG/Opus), so Pantheon — not
// OpenClaw — does the transcription. Returns plain text the router then treats
// exactly like a typed message.

export type Transcriber = (audio: Blob, filename: string) => Promise<string>;

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

export function createGroqTranscriber(apiKey: string, model: string): Transcriber {
  return async (audio, filename) => {
    const form = new FormData();
    form.append("file", audio, filename);
    form.append("model", model);
    form.append("response_format", "text");
    const res = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`groq transcription failed: ${res.status} ${detail}`);
    }
    return (await res.text()).trim();
  };
}
