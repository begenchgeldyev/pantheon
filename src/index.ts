// Pantheon entrypoint: wire config -> OpenClaw client -> router -> bot,
// start long polling, and shut down cleanly under systemd.

import { loadConfig } from "./config";
import { configureLogger, log } from "./logger";
import { createOpenClawClient } from "./openclaw";
import { Router } from "./router";
import { createBot } from "./telegram";

function main(): void {
  const config = loadConfig();
  configureLogger(config.logLevel);

  const client = createOpenClawClient(config);
  const router = new Router(client, config);
  const bot = createBot(config, router);

  // Set the command menu shown in Telegram clients (best-effort).
  bot.api
    .setMyCommands([
      { command: "start", description: "Check the connection" },
      { command: "help", description: "Show available commands" },
      { command: "agents", description: "List known agents" },
      { command: "agent", description: "Select the active agent" },
    ])
    .catch((err) => log.warn("failed to set commands", { error: String(err) }));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    await bot.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // bot.start() resolves only after the bot stops, so run it detached. A
  // rejection here means we never connected (bad token / network) — exit so
  // systemd restarts us instead of leaving a dead process.
  bot
    .start({
      onStart: (me) =>
        log.info("bot started", {
          username: me.username,
          defaultAgent: config.defaultAgent,
          agents: config.agents,
        }),
    })
    .catch((err) => {
      if (stopping) return;
      log.error("bot stopped unexpectedly", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    });
}

try {
  main();
} catch (err) {
  // Startup failures (e.g. missing config) should exit non-zero with a clear
  // message, without leaking secrets.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Pantheon failed to start: ${message}`);
  process.exit(1);
}
