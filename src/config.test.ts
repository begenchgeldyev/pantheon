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
