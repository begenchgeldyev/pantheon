import { test, expect } from "bun:test";
import { godsFor, isOwner, activeAgent, workspaceDirFor, HERMES_AGENT_ID } from "./gods";
import { loadConfig } from "./config";
import type { UserRecord } from "./registry";

const config = loadConfig({
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_ALLOWED_USERNAMES: "begench,amina",
  TELEGRAM_OWNER_USERNAME: "begench",
  PANTHEON_OWNER_GODS: "athena",
  NOTIFY_SECRET: "s",
  OPENCLAW_STATE_DIR: "/state",
});

const owner: UserRecord = { tgUserId: 1, username: "begench", chatId: 1, agentId: "main", createdAt: "", lastSeen: "" };
const user: UserRecord = { tgUserId: 2, username: "amina", chatId: 2, agentId: "u_2", createdAt: "", lastSeen: "" };

test("godsFor: owner gets Hermes + extra gods; others get only their own", () => {
  expect(godsFor(owner, config)).toEqual(["main", "athena"]);
  expect(godsFor(user, config)).toEqual(["u_2"]);
  expect(isOwner(owner, config)).toBe(true);
  expect(isOwner(user, config)).toBe(false);
});

test("activeAgent honours a valid selection, else falls back to the default god", () => {
  expect(activeAgent(owner, config, "athena")).toBe("athena");
  expect(activeAgent(owner, config, null)).toBe("main");
  expect(activeAgent(owner, config, "zeus")).toBe("main"); // not summonable -> default
  expect(activeAgent(user, config, "athena")).toBe("u_2"); // user can't reach athena
});

test("workspaceDirFor maps main to workspace and others to workspace-<id>", () => {
  expect(workspaceDirFor("/state", HERMES_AGENT_ID)).toBe("/state/workspace");
  expect(workspaceDirFor("/state", "athena")).toBe("/state/workspace-athena");
});
