import path from "node:path";
import type { Config } from "../config";
import { ConsoleTransport } from "../logger/console-transport";
import { Logger } from "../logger/logger";
import { createNotifyServer } from "../notify";
import { createOpenClawClient } from "../openclaw";
import { createCliRunner } from "../openclaw-cli";
import { Provisioner } from "../provisioner";
import { Registry } from "../registry";
import { Router } from "../router";
import { createGroqTranscriber } from "../transcribe";
import { createPiperSynthesizer } from "../tts";
import { createBot } from "../telegram";
import {
  BotToken, CliRunnerToken, ConfigToken, LoggerToken, NotifyServerToken,
  OpenClawToken, ProvisionerToken, RegistryToken, RouterToken,
} from "../tokens";
import { Container } from "./container";

const TEMPLATE_DIR = path.resolve(import.meta.dir, "../../workspace-template");

export function initContainers(config: Config) {
  const container = new Container();
  container.register(ConfigToken, { lifetime: "singleton", factory: () => config });
  container.register(LoggerToken, {
    lifetime: "singleton",
    factory: (c) => new Logger(new ConsoleTransport(), c.resolve(ConfigToken).logLevel),
  });
  container.register(OpenClawToken, {
    lifetime: "singleton",
    factory: (c) => createOpenClawClient(c.resolve(ConfigToken), c.resolve(LoggerToken)),
  });
  container.register(CliRunnerToken, {
    lifetime: "singleton",
    factory: (c) => createCliRunner(c.resolve(ConfigToken).openclawBin),
  });
  container.register(RegistryToken, {
    lifetime: "singleton",
    factory: (c) => new Registry(path.join(c.resolve(ConfigToken).dataDir, "users.sqlite")),
  });
  container.register(ProvisionerToken, {
    lifetime: "singleton",
    factory: (c) => new Provisioner({
      cli: c.resolve(CliRunnerToken), registry: c.resolve(RegistryToken),
      config: c.resolve(ConfigToken), templateDir: TEMPLATE_DIR, logger: c.resolve(LoggerToken),
    }),
  });
  container.register(RouterToken, {
    lifetime: "singleton",
    factory: (c) => new Router(c.resolve(OpenClawToken), c.resolve(RegistryToken), c.resolve(ConfigToken), c.resolve(LoggerToken)),
  });
  container.register(BotToken, {
    lifetime: "singleton",
    factory: (c) => {
      const config = c.resolve(ConfigToken);
      const transcriber = config.groqApiKey
        ? createGroqTranscriber(config.groqApiKey, config.groqModel)
        : undefined;
      const synthesizer = config.piperBin
        ? createPiperSynthesizer(config.piperBin, config.piperVoicesDir)
        : undefined;
      return createBot(
        config, c.resolve(RouterToken), c.resolve(ProvisionerToken),
        c.resolve(RegistryToken), c.resolve(LoggerToken), { transcriber, synthesizer },
      );
    },
  });
  container.register(NotifyServerToken, {
    lifetime: "singleton",
    factory: (c) => createNotifyServer(
      c.resolve(ConfigToken), c.resolve(BotToken), c.resolve(RegistryToken), c.resolve(LoggerToken),
    ),
  });
  return container;
}
