import type { Bot } from 'grammy';
import type { Config } from './config';
import { Token } from './container/token';
import type { Logger } from './logger/logger';
import type { createNotifyServer } from './notify';
import type { Router } from './router';
import type { OpenClawClient } from './types';

type NotifyServer = ReturnType<typeof createNotifyServer>;

export const ConfigToken        = new Token<Config>("Config");
export const LoggerToken        = new Token<Logger>("Logger");
export const OpenClawToken      = new Token<OpenClawClient>("OpenClawClient");
export const RouterToken        = new Token<Router>("Router");
export const BotToken           = new Token<Bot>("Bot");
export const NotifyServerToken  = new Token<NotifyServer>("NotifyServer");