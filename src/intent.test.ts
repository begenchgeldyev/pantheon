import { test, expect } from "bun:test";
import { classifyIntent } from "./intent";

test("routes reminder-ish messages to Hermes", () => {
  for (const t of ["remind me to call mom tomorrow", "don't forget the dentist", "when is Anna's birthday?", "set a reminder for the deadline"]) {
    expect(classifyIntent(t, "athena")).toBe("main");
  }
});

test("routes job-hunt messages to Athena", () => {
  for (const t of ["find me a remote job", "any new vacancies?", "tailor my résumé", "what's the salary for that role?", "update my CV"]) {
    expect(classifyIntent(t, "athena")).toBe("athena");
  }
});

test("returns null when there is no clear signal or both match", () => {
  expect(classifyIntent("hey, how are you?", "athena")).toBeNull();
  expect(classifyIntent("what can you do?", "athena")).toBeNull();
  expect(classifyIntent("remind me to apply for that job", "athena")).toBeNull(); // both → ambiguous
});

test("never routes to Athena when the owner has no Athena", () => {
  expect(classifyIntent("find me a job", null)).toBeNull();
  expect(classifyIntent("remind me tomorrow", null)).toBe("main");
});

test("routes matters of the heart to Aphrodite", () => {
  for (const t of ["what gift should I get for Anna?", "help me write a love note", "date night ideas for friday", "my girlfriend is upset with me"]) {
    expect(classifyIntent(t, "athena", "aphrodite")).toBe("aphrodite");
  }
});

test("gift + date keywords together are ambiguous, not Hermes", () => {
  expect(classifyIntent("gift ideas for mom's birthday", "athena", "aphrodite")).toBeNull(); // birthday+gift → LLM decides
  expect(classifyIntent("anniversary gift for my wife", "athena", "aphrodite")).toBeNull();
  expect(classifyIntent("when is Anna's birthday?", "athena", "aphrodite")).toBe("main"); // pure date → still Hermes
});

test("never routes to Aphrodite when the owner has no Aphrodite", () => {
  expect(classifyIntent("what gift should I get for Anna?", "athena")).toBeNull();
  expect(classifyIntent("gift ideas for mom's birthday", "athena")).toBe("main"); // no aphrodite → birthday wins as before
});
