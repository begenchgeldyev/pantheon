import { test, expect } from "bun:test";
import { extractResponseText, OpenClawError } from "./openclaw";

test("extracts a top-level string field", () => {
  expect(extractResponseText(JSON.stringify({ response: "hi" }))).toBe("hi");
  expect(extractResponseText(JSON.stringify({ text: "yo" }))).toBe("yo");
});

test("extracts from a data envelope", () => {
  const raw = JSON.stringify({ data: { message: "nested" } });
  expect(extractResponseText(raw)).toBe("nested");
});

test("extracts the last chat message", () => {
  const raw = JSON.stringify({
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "answer" },
    ],
  });
  expect(extractResponseText(raw)).toBe("answer");
});

test("accepts a bare JSON string", () => {
  expect(extractResponseText(JSON.stringify("plain"))).toBe("plain");
});

test("throws on invalid JSON", () => {
  expect(() => extractResponseText("not json")).toThrow(OpenClawError);
});

test("throws with observed keys when no field matches", () => {
  try {
    extractResponseText(JSON.stringify({ foo: 1, bar: 2 }));
    throw new Error("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(OpenClawError);
    expect((err as OpenClawError).detail).toEqual({ keys: ["foo", "bar"] });
  }
});
