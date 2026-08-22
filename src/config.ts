import path from "node:path";
import type { LoggerSeverity } from "./logger";

export type Config = {
  /** Telegram bot token from BotFather. Secret. */
  botToken: string;
  /** Telegram usernames allowed to talk to the bot (lower-case, no '@'). */
  allowedUsernames: Set<string>;
  /** Username mapped to the pre-existing `main` agent. Must be allowed. */
  ownerUsername: string;
  /** Extra OpenClaw agent ids the owner may summon (besides `main`), e.g. `athena`. */
  ownerGods: string[];
  /** The router/front-door god (e.g. `zeus`): the default when intent is unclear. Empty = none. */
  routerAgent: string;
  /** Groq API key for voice-note transcription (Whisper). Empty = voice disabled. Secret. */
  groqApiKey: string;
  /** Groq transcription model. */
  groqModel: string;
  /** Groq chat model used to route the owner's unclear messages to a god. Empty = keyword routing only. */
  classifierModel: string;
  /** Executable name or path for the OpenClaw CLI. */
  openclawBin: string;
  /** OpenClaw state dir (holds workspace*, agents/, openclaw.json). */
  openclawStateDir: string;
  /** Hard timeout for a single OpenClaw turn, in milliseconds. */
  openclawTimeoutMs: number;
  /** Directory for Pantheon's own data (users.sqlite). */
  dataDir: string;
  /** Root for the remind wrappers; per-agent dirs live in `<binDir>/agents/<id>`. */
  binDir: string;
  /** Directory holding the shared remind implementations the wrappers exec. */
  remindImplDir: string;
  logLevel: LoggerSeverity;
  notifyHost: string;
  notifyPort: number;
  notifySecret: string;
};

class ConfigError extends Error {
  override name = "ConfigError";
}

export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`Missing required environment variable: ${name}`);
  return value;
}

function optional(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function parsePositiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`Environment variable ${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

function parseLogLevel(raw: string): LoggerSeverity {
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  throw new ConfigError(`LOG_LEVEL must be one of debug|info|warn|error, got: ${raw}`);
}

export function loadConfig(env: Env = process.env): Config {
  const botToken = required(env, "TELEGRAM_BOT_TOKEN");

  const allowedUsernames = new Set(
    required(env, "TELEGRAM_ALLOWED_USERNAMES")
      .split(",")
      .map(normalizeUsername)
      .filter((u) => u.length > 0),
  );
  if (allowedUsernames.size === 0) {
    throw new ConfigError("TELEGRAM_ALLOWED_USERNAMES must contain at least one username");
  }

  const ownerUsername = normalizeUsername(required(env, "TELEGRAM_OWNER_USERNAME"));
  if (!allowedUsernames.has(ownerUsername)) {
    throw new ConfigError("TELEGRAM_OWNER_USERNAME must be one of TELEGRAM_ALLOWED_USERNAMES");
  }

  // Extra gods the owner may summon besides Hermes (`main`). Agent ids only.
  const ownerGods = Array.from(
    new Set(
      optional(env, "PANTHEON_OWNER_GODS", "")
        .split(",")
        .map((g) => g.trim())
        .filter((g) => g.length > 0 && g !== "main"),
    ),
  );
  for (const g of ownerGods) {
    if (!/^[a-z][a-z0-9_]*$/.test(g)) {
      throw new ConfigError(`PANTHEON_OWNER_GODS entry is not a valid agent id: ${g}`);
    }
  }

  const routerAgent = optional(env, "PANTHEON_ROUTER", "").trim();
  if (routerAgent && !/^[a-z][a-z0-9_]*$/.test(routerAgent)) {
    throw new ConfigError(`PANTHEON_ROUTER is not a valid agent id: ${routerAgent}`);
  }

  const groqApiKey = optional(env, "GROQ_API_KEY", "");
  const groqModel = optional(env, "GROQ_MODEL", "whisper-large-v3");
  const classifierModel = optional(env, "PANTHEON_CLASSIFIER_MODEL", "qwen/qwen3.6-27b");

  const openclawBin = optional(env, "OPENCLAW_BIN", "openclaw");
  const openclawStateDir = optional(env, "OPENCLAW_STATE_DIR", "/home/openclaw/.openclaw");
  const openclawTimeoutMs =
    parsePositiveInt("OPENCLAW_TIMEOUT_SECONDS", optional(env, "OPENCLAW_TIMEOUT_SECONDS", "120")) * 1000;
  const dataDir = path.resolve(optional(env, "PANTHEON_DATA_DIR", "./data"));
  const binDir = optional(env, "PANTHEON_BIN_DIR", "/home/openclaw/bin");
  // Default matches `bin/install-remind-wrappers`, so wrappers written by the
  // provisioner and by the deploy script are byte-identical.
  const remindImplDir = optional(env, "REMIND_IMPL_DIR", "/home/openclaw/bin/remind-impl");
  const logLevel = parseLogLevel(optional(env, "LOG_LEVEL", "info"));
  const notifyHost = optional(env, "NOTIFY_HOST", "127.0.0.1");
  const notifyPort = parsePositiveInt("NOTIFY_PORT", optional(env, "NOTIFY_PORT", "8477"));
  const notifySecret = required(env, "NOTIFY_SECRET");

  return {
    botToken, allowedUsernames, ownerUsername, ownerGods, routerAgent, groqApiKey, groqModel, classifierModel, openclawBin, openclawStateDir,
    openclawTimeoutMs, dataDir, binDir, remindImplDir, logLevel, notifyHost,
    notifyPort, notifySecret,
  };
}
