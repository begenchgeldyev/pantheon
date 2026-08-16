// Pantheon entrypoint: wire config -> OpenClaw client -> router -> bot,
// start long polling, and shut down cleanly under systemd.

import { loadConfig } from "./config";
import { logger } from "./logger/logger";
import { createNotifyServer } from "./notify";
import { createOpenClawClient } from "./openclaw";
import { Router } from "./router";
import { createBot } from "./telegram";

function main(): void {
  const config = loadConfig();

  const client = createOpenClawClient(config);
  const router = new Router(client, config);
  const bot = createBot(config, router);
  const notifyServer = createNotifyServer(config, bot);
  logger.info("notify server listening", {
    host: config.notifyHost,
    port: config.notifyPort,
  });

  // Set the command menu shown in Telegram clients (best-effort).
  bot.api
    .setMyCommands([
      { command: "start", description: "Check the connection" },
      { command: "help", description: "Show available commands" },
      { command: "agents", description: "List known agents" },
      { command: "agent", description: "Select the active agent" },
    ])
    .catch((err) => logger.warn("failed to set commands", { error: String(err) }));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { signal });
    notifyServer.stop(true);
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
        logger.info("bot started", {
          username: me.username,
          defaultAgent: config.defaultAgent,
          agents: config.agents,
        }),
    })
    .catch((err) => {
      if (stopping) return;
      logger.error("bot stopped unexpectedly", {
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
