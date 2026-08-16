import type { Logger } from './logger';

export type LoggerSeverity = keyof typeof Logger.SEVERITIES;
export type Fields = Record<string, unknown>;

export interface LoggerTransport {
  write(severity: LoggerSeverity, message: string): void;
}