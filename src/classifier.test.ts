import { test, expect } from "bun:test";
import { buildPrompt, createGroqClassifier, parseChoice } from "./classifier";
import { GOD_PROFILES, godProfile } from "./gods";

const gods = [godProfile("zeus"), godProfile("main"), godProfile("athena")];

test("parseChoice accepts a bare id, with punctuation, case-insensitively", () => {
  expect(parseChoice("main", gods)).toBe("main");
  expect(parseChoice("Athena.", gods)).toBe("athena");
  expect(parseChoice("\n zeus \n", gods)).toBe("zeus");
});

test("parseChoice rejects unknown, empty or ambiguous answers", () => {
  expect(parseChoice("apollo", gods)).toBeNull();
  expect(parseChoice("", gods)).toBeNull();
  expect(parseChoice("main or athena", gods)).toBeNull();
  expect(parseChoice("mainframe", gods)).toBeNull(); // no substring matches
});

test("prompt lists every god and mentions the previous handler", () => {
  const p = buildPrompt("сколько ехать до вокзала?", gods, "main");
  for (const g of gods) expect(p).toContain(`- ${g.id}: ${g.name}`);
  expect(p).toContain('handled by "main"');
  expect(p).toContain("сколько ехать до вокзала?");
  expect(buildPrompt("hi", gods, null)).toContain("first message");
});

test("profiles exist for the known gods and fall back for unknown ids", () => {
  expect(GOD_PROFILES.main?.name).toBe("Hermes");
  expect(godProfile("apollo")).toEqual({ id: "apollo", name: "Apollo", domain: "a specialist agent" });
});

test("groq classifier posts one completion and returns the parsed god", async () => {
  let seen: { url: string; body: Record<string, unknown> } | null = null;
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen = { url, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ choices: [{ message: { content: "athena" } }] }));
  }) as unknown as typeof fetch;
  const classify = createGroqClassifier("k", "llama-test", { fetchFn });
  expect(await classify("any new vacancies in Tomsk?", gods, "zeus")).toBe("athena");
  expect(seen!.url).toContain("groq.com");
  expect(seen!.body.model).toBe("llama-test");
  expect(seen!.body.temperature).toBe(0);
});

test("groq classifier throws on HTTP errors and returns null when only one god", async () => {
  const fetchFn = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const classify = createGroqClassifier("k", "m", { fetchFn });
  await expect(classify("hi", gods, null)).rejects.toThrow(/500/);
  expect(await classify("hi", [gods[0]!], null)).toBeNull();
});
