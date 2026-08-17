// Pantheon entrypoint: wire config -> OpenClaw client -> router -> bot,
// start long polling, and shut down cleanly under systemd.

import { loadConfig } from "./config";
import { initContainers } from './container/init-containers';
import { BotToken, LoggerToken, NotifyServerToken } from './tokens';

function main(): void {
  const config = loadConfig();
  const container = initContainers(config);
  const logger = container.resolve(LoggerToken);
  const bot = container.resolve(BotToken);
  const notifyServer = container.resolve(NotifyServerToken);
  logger.info("notify server listening", {
    host: config.notifyHost,
    port: config.notifyPort,
  });

  // Set the command menu shown in Telegram clients (best-effort).
  bot.api
    .setMyCommands([
      { command: "start", description: "Check the connection" },
      { command: "help", description: "Show available commands" },
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
          allowedUsers: config.allowedUsernames.size,
          owner: config.ownerUsername,
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
