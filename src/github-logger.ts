import type { IntegrationBinding } from "@todu/core";

export type SyncDirection = "pull" | "push";
export type SyncEntityType = "issue" | "comment" | "label" | "status";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface SyncLogContext {
  bindingId: IntegrationBinding["id"];
  projectId?: string;
  repo?: string;
  direction?: SyncDirection;
  entityType?: SyncEntityType;
  itemId?: string;
}

export interface SyncLogEntry {
  level: LogLevel;
  message: string;
  context: SyncLogContext;
  error?: string;
  timestamp: string;
}

export interface GitHubSyncLogger {
  debug(message: string, context: SyncLogContext): void;
  info(message: string, context: SyncLogContext): void;
  warn(message: string, context: SyncLogContext): void;
  error(message: string, context: SyncLogContext, error?: string): void;
  getEntries(): SyncLogEntry[];
}

export function createGitHubSyncLogger(): GitHubSyncLogger {
  const entries: SyncLogEntry[] = [];

  const log = (level: LogLevel, message: string, context: SyncLogContext, error?: string): void => {
    entries.push({
      level,
      message,
      context: { ...context },
      error,
      timestamp: new Date().toISOString(),
    });
  };

  return {
    debug(message, context): void {
      log("debug", message, context);
    },
    info(message, context): void {
      log("info", message, context);
    },
    warn(message, context): void {
      log("warn", message, context);
    },
    error(message, context, error): void {
      log("error", message, context, error);
    },
    getEntries(): SyncLogEntry[] {
      return entries.map((entry) => ({ ...entry, context: { ...entry.context } }));
    },
  };
}

export function formatLogEntry(entry: SyncLogEntry): string {
  const parts = [
    `[${entry.timestamp}]`,
    `[${entry.level.toUpperCase()}]`,
    `[binding:${entry.context.bindingId}]`,
  ];

  if (entry.context.repo) {
    parts.push(`[repo:${entry.context.repo}]`);
  }

  if (entry.context.direction) {
    parts.push(`[${entry.context.direction}]`);
  }

  if (entry.context.entityType) {
    parts.push(`[${entry.context.entityType}]`);
  }

  if (entry.context.itemId) {
    parts.push(`[item:${entry.context.itemId}]`);
  }

  parts.push(entry.message);

  if (entry.error) {
    parts.push(`| error: ${entry.error}`);
  }

  return parts.join(" ");
}
