import { ConsoleTransport } from './console-transport';
import type { Fields, LoggerSeverity, LoggerTransport } from './logger.type';

export class Logger {
  static readonly SEVERITIES = {
    debug: 10, info: 20, warn: 30, error: 40,
  } as const
  private readonly threshold: number;

  constructor(private readonly transport: LoggerTransport, severity: LoggerSeverity = 'info') {
    this.threshold = Logger.SEVERITIES[severity];
  }

  private write(severity: LoggerSeverity, message: string, fields?: Fields) {
    if (Logger.SEVERITIES[severity] < this.threshold) return;
    const line = JSON.stringify({ time: new Date().toISOString(), severity, message, ...fields });
    
    this.transport.write(severity, line);
  }

  debug(message: string, fields?: Fields) {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: Fields) {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: Fields) {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: Fields) {
    this.write('error', message, fields);
  }
}

export const logger = new Logger(new ConsoleTransport(), 'info');
