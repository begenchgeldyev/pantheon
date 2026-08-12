// Lightweight structured logging to stdout (journald-friendly under systemd).
//
// One JSON object per line. We deliberately never pass secrets or full
// conversation text through here — callers log metadata only.

import type { LogLevel } from "./config";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

type Fields = Record<string, unknown>;

let threshold = LEVEL_ORDER.info;

export function configureLogger(level: LogLevel): void {
  threshold = LEVEL_ORDER[level];
}

function emit(level: LogLevel, msg: string, fields?: Fields): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
