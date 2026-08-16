import type { LoggerSeverity, LoggerTransport } from './logger.type';

export class ConsoleTransport implements LoggerTransport {
  write(message: string, severity: LoggerSeverity) {
    if (severity === 'warn' || severity === 'error') {
        console.error(message)
        return;
    }

    console.log(message)
  }
}