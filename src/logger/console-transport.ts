import type { LoggerSeverity, LoggerTransport } from './logger.type';

export class ConsoleTransport implements LoggerTransport {
  write(severity: LoggerSeverity, message: string) {
    if (severity === 'warn' || severity === 'error') {
        console.error(message)
        return;
    }

    console.log(message)
  }
}