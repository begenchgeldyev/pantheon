import { test, expect, afterEach } from "bun:test";
import { createGroqTranscriber } from "./transcribe";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("posts audio to Groq with auth + model and returns the transcript text", async () => {
  let captured: { url: string; auth: string | null; hasFile: boolean; model: unknown } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const form = init.body as FormData;
    captured = {
      url: String(url),
      auth: new Headers(init.headers).get("authorization"),
      hasFile: form.has("file"),
      model: form.get("model"),
    };
    return new Response("  hello from the void  ");
  }) as unknown as typeof fetch;

  const transcribe = createGroqTranscriber("gsk_secret", "whisper-large-v3");
  const text = await transcribe(new Blob([new Uint8Array([1, 2, 3])]), "voice.ogg");

  expect(text).toBe("hello from the void");
  expect(captured!.url).toContain("api.groq.com");
  expect(captured!.auth).toBe("Bearer gsk_secret");
  expect(captured!.hasFile).toBe(true);
  expect(captured!.model).toBe("whisper-large-v3");
});

test("throws with status detail on a non-2xx response", async () => {
  globalThis.fetch = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
  const transcribe = createGroqTranscriber("gsk_bad", "whisper-large-v3");
  await expect(transcribe(new Blob([new Uint8Array([1])]), "v.ogg")).rejects.toThrow(/401/);
});
