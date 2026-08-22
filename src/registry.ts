// User registry: Telegram user -> OpenClaw agent.
//
// SQLite via bun:sqlite. This is the single source of truth for "which agent
// belongs to which Telegram user" and is used in both directions:
//   inbound  — telegram user id -> agent id (Router)
//   outbound — agent id -> chat id (notify endpoint)

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type UserRecord = {
  tgUserId: number;
  username: string;
  chatId: number;
  agentId: string;
  createdAt: string;
  lastSeen: string;
};

type Row = {
  tg_user_id: number; username: string; chat_id: number; agent_id: string;
  created_at: string; last_seen: string;
};

function toRecord(row: Row): UserRecord {
  return {
    tgUserId: row.tg_user_id, username: row.username, chatId: row.chat_id,
    agentId: row.agent_id, createdAt: row.created_at, lastSeen: row.last_seen,
  };
}

export class Registry {
  private readonly db: Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        tg_user_id INTEGER PRIMARY KEY,
        username   TEXT NOT NULL,
        chat_id    INTEGER NOT NULL,
        agent_id   TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen  TEXT NOT NULL
      );
    `);
    // Which god a chat is currently talking to (owner can switch between gods).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_selection (
        chat_id    INTEGER PRIMARY KEY,
        agent_id   TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  /** The agent this chat is currently pointed at, or null if never set. */
  getChatSelection(chatId: number): string | null {
    const row = this.db
      .query<{ agent_id: string }, [number]>("SELECT agent_id FROM chat_selection WHERE chat_id = ?")
      .get(chatId);
    return row ? row.agent_id : null;
  }

  setChatSelection(chatId: number, agentId: string): void {
    this.db
      .query(
        "INSERT INTO chat_selection (chat_id, agent_id, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(chat_id) DO UPDATE SET agent_id = excluded.agent_id, updated_at = excluded.updated_at",
      )
      .run(chatId, agentId, new Date().toISOString());
  }

  /** Forget the chat's pinned god, so routing decides per message again. */
  clearChatSelection(chatId: number): void {
    this.db.query("DELETE FROM chat_selection WHERE chat_id = ?").run(chatId);
  }

  findByUserId(tgUserId: number): UserRecord | null {
    const row = this.db.query<Row, [number]>("SELECT * FROM users WHERE tg_user_id = ?").get(tgUserId);
    return row ? toRecord(row) : null;
  }

  findByAgentId(agentId: string): UserRecord | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM users WHERE agent_id = ?").get(agentId);
    return row ? toRecord(row) : null;
  }

  insert(u: { tgUserId: number; username: string; chatId: number; agentId: string }): UserRecord {
    const now = new Date().toISOString();
    this.db
      .query("INSERT INTO users (tg_user_id, username, chat_id, agent_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
      .run(u.tgUserId, u.username, u.chatId, u.agentId, now, now);
    return { ...u, createdAt: now, lastSeen: now };
  }

  touch(tgUserId: number, username: string, chatId: number): void {
    this.db
      .query("UPDATE users SET username = ?, chat_id = ?, last_seen = ? WHERE tg_user_id = ?")
      .run(username, chatId, new Date().toISOString(), tgUserId);
  }

  close(): void {
    this.db.close();
  }
}
