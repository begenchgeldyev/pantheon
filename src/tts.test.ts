import { test, expect } from "bun:test";
import { voiceForAgent, DEFAULT_VOICE } from "./tts";

test("each god maps to its own voice; unknown agents get the default", () => {
  expect(voiceForAgent("zeus")).toBe("en_US-ryan-high");
  expect(voiceForAgent("athena")).toBe("en_US-amy-medium");
  expect(voiceForAgent("main")).toBe("en_US-joe-medium");
  expect(voiceForAgent("u_42")).toBe(DEFAULT_VOICE);
});
