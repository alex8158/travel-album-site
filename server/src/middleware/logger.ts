/**
 * Structured logger for critical operations.
 * Outputs JSON-formatted log entries for easy parsing and monitoring.
 */

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  [key: string]: unknown;
}

function formatEntry(level: LogEntry['level'], message: string, meta?: Record<string, unknown>): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>): void {
    const entry = formatEntry('info', message, meta);
    console.log(JSON.stringify(entry));
  },

  warn(message: string, meta?: Record<string, unknown>): void {
    const entry = formatEntry('warn', message, meta);
    console.warn(JSON.stringify(entry));
  },

  error(message: string, meta?: Record<string, unknown>): void {
    const entry = formatEntry('error', message, meta);
    console.error(JSON.stringify(entry));
  },
};
