import { test, expect } from "bun:test";
import { isAllowed, splitMessage } from "./telegram";

test("short text is a single chunk", () => {
  expect(splitMessage("hello")).toEqual(["hello"]);
});

test("splits long text within the limit", () => {
  const text = "a".repeat(9000);
  const chunks = splitMessage(text, 4000);
  expect(chunks.length).toBe(3);
  for (const c of chunks) expect(Array.from(c).length).toBeLessThanOrEqual(4000);
  expect(chunks.join("")).toBe(text);
});

test("prefers to break on a newline", () => {
  const text = "x".repeat(3000) + "\n" + "y".repeat(2000);
  const chunks = splitMessage(text, 4000);
  expect(chunks.length).toBe(2);
  expect(chunks[0]).toBe("x".repeat(3000));
  expect(chunks[1]).toBe("y".repeat(2000));
});

test("does not break Unicode code points", () => {
  // Each emoji is a surrogate pair (length 2 in UTF-16, 1 code point).
  const text = "😀".repeat(3000);
  const chunks = splitMessage(text, 1000);
  for (const c of chunks) {
    // A broken surrogate would render as �; ensure none appear.
    expect(c.includes("�")).toBe(false);
  }
  expect(chunks.join("")).toBe(text);
});

test("isAllowed matches case-insensitively and rejects missing usernames", () => {
  const allowed = new Set(["begench", "amina"]);
  expect(isAllowed("Begench", allowed)).toBe(true);
  expect(isAllowed("@amina", allowed)).toBe(true);
  expect(isAllowed("ghost", allowed)).toBe(false);
  expect(isAllowed(undefined, allowed)).toBe(false);
});
