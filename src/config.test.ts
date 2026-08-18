import { test, expect } from "bun:test";
import { loadConfig, normalizeUsername } from "./config";

const base = {
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_ALLOWED_USERNAMES: "Begench, @amina ,",
  TELEGRAM_OWNER_USERNAME: "@Begench",
  NOTIFY_SECRET: "s",
};

test("normalizeUsername strips @, trims and lower-cases", () => {
  expect(normalizeUsername("  @Begench ")).toBe("begench");
});

test("parses allowed usernames and owner", () => {
  const c = loadConfig(base);
  expect([...c.allowedUsernames].sort()).toEqual(["amina", "begench"]);
  expect(c.ownerUsername).toBe("begench");
  expect(c.dataDir.endsWith("/data")).toBe(true);
  expect(c.openclawStateDir).toBe("/home/openclaw/.openclaw");
});

test("owner must be in the allowed list", () => {
  expect(() => loadConfig({ ...base, TELEGRAM_OWNER_USERNAME: "ghost" })).toThrow(/owner/i);
});

test("requires at least one allowed username", () => {
  expect(() => loadConfig({ ...base, TELEGRAM_ALLOWED_USERNAMES: " , " })).toThrow(/TELEGRAM_ALLOWED_USERNAMES/);
});

import { loadConfig as loadConfig2 } from "./config";

const baseGods = {
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_ALLOWED_USERNAMES: "begench",
  TELEGRAM_OWNER_USERNAME: "begench",
  NOTIFY_SECRET: "s",
};

test("ownerGods parses, dedupes, drops main", () => {
  expect(loadConfig2({ ...baseGods, PANTHEON_OWNER_GODS: "athena, athena ,main" }).ownerGods).toEqual(["athena"]);
  expect(loadConfig2(baseGods).ownerGods).toEqual([]);
});

test("ownerGods rejects invalid agent ids", () => {
  expect(() => loadConfig2({ ...baseGods, PANTHEON_OWNER_GODS: "Bad Id" })).toThrow(/PANTHEON_OWNER_GODS/);
});

import { loadConfig as loadConfig3 } from "./config";

test("routerAgent parses and validates", () => {
  const base = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ALLOWED_USERNAMES: "b", TELEGRAM_OWNER_USERNAME: "b", NOTIFY_SECRET: "s" };
  expect(loadConfig3({ ...base, PANTHEON_ROUTER: "zeus" }).routerAgent).toBe("zeus");
  expect(loadConfig3(base).routerAgent).toBe("");
  expect(() => loadConfig3({ ...base, PANTHEON_ROUTER: "Bad" })).toThrow(/PANTHEON_ROUTER/);
});

import { loadConfig as loadConfig4 } from "./config";

test("groq config is optional with a sensible model default", () => {
  const base = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ALLOWED_USERNAMES: "b", TELEGRAM_OWNER_USERNAME: "b", NOTIFY_SECRET: "s" };
  expect(loadConfig4(base).groqApiKey).toBe("");
  expect(loadConfig4(base).groqModel).toBe("whisper-large-v3");
  const c = loadConfig4({ ...base, GROQ_API_KEY: "gsk_x", GROQ_MODEL: "whisper-large-v3-turbo" });
  expect(c.groqApiKey).toBe("gsk_x");
  expect(c.groqModel).toBe("whisper-large-v3-turbo");
});
