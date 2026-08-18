// Document intake: validate and place files a user uploads over Telegram.
//
// Pure helpers — the Telegram layer does the actual download and write given
// the resolved path. Keeps the risky parts (path traversal, type/size gating)
// unit-testable without a bot or a filesystem.

import path from "node:path";
import { workspaceDirFor } from "./gods";

export const MAX_DOC_BYTES = 20 * 1024 * 1024; // 20 MB
export const ALLOWED_DOC_EXT = new Set([".pdf", ".md", ".txt", ".docx", ".doc", ".rtf"]);

/** Strip any path, keep a safe basename. Never returns "" or a traversal. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").replace(/_+/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 128) : "file";
}

export function isAllowedDoc(name: string, size: number): { ok: true } | { ok: false; reason: string } {
  if (size > MAX_DOC_BYTES) {
    return { ok: false, reason: `That file is too large (max ${Math.floor(MAX_DOC_BYTES / 1024 / 1024)} MB).` };
  }
  const ext = path.extname(sanitizeFilename(name)).toLowerCase();
  if (!ALLOWED_DOC_EXT.has(ext)) {
    return { ok: false, reason: `I can only take these file types: ${[...ALLOWED_DOC_EXT].join(", ")}.` };
  }
  return { ok: true };
}

/** Absolute path where an uploaded file lands inside an agent's workspace inbox. */
export function inboxPathFor(stateDir: string, agentId: string, name: string): string {
  return path.join(workspaceDirFor(stateDir, agentId), "inbox", sanitizeFilename(name));
}
