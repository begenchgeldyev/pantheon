// Configuration loading and validation.
//
// Bun automatically loads .env, so we only read from process.env here.
// Required variables are validated at startup; anything missing throws a
// clear error before the bot ever connects to Telegram.

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Config = {
  /** Telegram bot token from BotFather. Secret. */
  botToken: string;
  /** Numeric Telegram user id allowed to talk to the bot. */
  allowedUserId: number;
  /** Agent used when the user hasn't explicitly selected one. */
  defaultAgent: string;
  /** All agents Pantheon knows about (always includes defaultAgent). */
  agents: string[];
  /** Executable name or path for the OpenClaw CLI. */
  openclawBin: string;
  /** Hard timeout for a single OpenClaw turn, in milliseconds. */
  openclawTimeoutMs: number;
  logLevel: LogLevel;
};

class ConfigError extends Error {
  override name = "ConfigError";
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function parsePositiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(
      `Environment variable ${name} must be a positive integer, got: ${raw}`,
    );
  }
  return n;
}

function parseLogLevel(raw: string): LogLevel {
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  throw new ConfigError(
    `LOG_LEVEL must be one of debug|info|warn|error, got: ${raw}`,
  );
}

/**
 * Load and validate configuration. Throws ConfigError with an actionable
 * message if anything required is missing or malformed.
 */
export function loadConfig(): Config {
  const botToken = required("TELEGRAM_BOT_TOKEN");
  const allowedUserId = parsePositiveInt(
    "TELEGRAM_ALLOWED_USER_ID",
    required("TELEGRAM_ALLOWED_USER_ID"),
  );
  const defaultAgent = required("DEFAULT_AGENT");

  // OPENCLAW_AGENTS is an optional comma-separated allowlist. The default
  // agent is always included so it can never be "unknown".
  const configuredAgents = optional("OPENCLAW_AGENTS", "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  const agents = Array.from(new Set([defaultAgent, ...configuredAgents]));

  const openclawBin = optional("OPENCLAW_BIN", "openclaw");
  const openclawTimeoutMs =
    parsePositiveInt(
      "OPENCLAW_TIMEOUT_SECONDS",
      optional("OPENCLAW_TIMEOUT_SECONDS", "120"),
    ) * 1000;
  const logLevel = parseLogLevel(optional("LOG_LEVEL", "info"));

  return {
    botToken,
    allowedUserId,
    defaultAgent,
    agents,
    openclawBin,
    openclawTimeoutMs,
    logLevel,
  };
}
