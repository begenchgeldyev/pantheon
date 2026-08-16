import type { Config } from '../config';
import { ConsoleTransport } from '../logger/console-transport';
import { Logger } from '../logger/logger';
import { createNotifyServer } from '../notify';
import { createOpenClawClient } from '../openclaw';
import { Router } from '../router';
import { createBot } from '../telegram';
import { BotToken, ConfigToken, LoggerToken, NotifyServerToken, OpenClawToken, RouterToken } from '../tokens';
import { Container } from './container';

export function initContainers(config: Config) {
  const container = new Container()
  container.register(ConfigToken, {
    lifetime: "singleton",
    factory: () => config,
  });

  container.register(LoggerToken, {
    lifetime: "singleton",
    factory: (container) => new Logger(new ConsoleTransport(), container.resolve(ConfigToken).logLevel),
  });

  container.register(OpenClawToken, {
    lifetime: "singleton",
    factory: (container) => createOpenClawClient(container.resolve(ConfigToken), container.resolve(LoggerToken)),
  });

  container.register(RouterToken, {
    lifetime: "singleton",
    factory: (container) => new Router(
      container.resolve(OpenClawToken),
      container.resolve(ConfigToken),
      container.resolve(LoggerToken),
    ),
  });

  container.register(BotToken, {
    lifetime: "singleton",
    factory: (container) => createBot(
      container.resolve(ConfigToken),
      container.resolve(RouterToken),
      container.resolve(LoggerToken),
    ),
  });

  container.register(NotifyServerToken, {
    lifetime: "singleton",
    factory: (container) => createNotifyServer(
      container.resolve(ConfigToken),
      container.resolve(BotToken),
      container.resolve(LoggerToken),
    ),
  });

  return container;
}