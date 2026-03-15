import fs from "node:fs";
import path from "node:path";

import type { IntegrationBinding } from "@todu/core";

export interface BindingRuntimeState {
  bindingId: IntegrationBinding["id"];
  cursor: string | null;
  retryAttempt: number;
  nextRetryAt: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
}

export interface BindingRuntimeStore {
  get(bindingId: IntegrationBinding["id"]): BindingRuntimeState | null;
  save(state: BindingRuntimeState): void;
  remove(bindingId: IntegrationBinding["id"]): void;
  listAll(): BindingRuntimeState[];
}

export interface RetryConfig {
  initialSeconds: number;
  maxSeconds: number;
}

export interface RetryOverride {
  delaySeconds?: number;
  retryAt?: Date;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  initialSeconds: 5,
  maxSeconds: 300,
};

export function createInitialRuntimeState(
  bindingId: IntegrationBinding["id"]
): BindingRuntimeState {
  return {
    bindingId,
    cursor: null,
    retryAttempt: 0,
    nextRetryAt: null,
    lastError: null,
    lastSuccessAt: null,
    lastAttemptAt: null,
  };
}

export function computeNextRetryDelay(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): number {
  if (attempt <= 0) {
    return 0;
  }

  const delaySeconds = Math.min(
    config.initialSeconds * Math.pow(2, attempt - 1),
    config.maxSeconds
  );

  return delaySeconds;
}

export function recordSuccess(
  state: BindingRuntimeState,
  cursor: string | null,
  now: Date = new Date()
): BindingRuntimeState {
  return {
    ...state,
    cursor,
    retryAttempt: 0,
    nextRetryAt: null,
    lastError: null,
    lastSuccessAt: now.toISOString(),
    lastAttemptAt: now.toISOString(),
  };
}

export function recordFailure(
  state: BindingRuntimeState,
  error: string,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  now: Date = new Date(),
  retryOverride?: RetryOverride
): BindingRuntimeState {
  const nextAttempt = state.retryAttempt + 1;
  const delaySeconds = retryOverride?.delaySeconds ?? computeNextRetryDelay(nextAttempt, config);
  const overrideRetryAt = retryOverride?.retryAt;
  const nextRetryAt =
    overrideRetryAt != null
      ? new Date(Math.max(overrideRetryAt.getTime(), now.getTime()))
      : new Date(now.getTime() + delaySeconds * 1000);

  return {
    ...state,
    retryAttempt: nextAttempt,
    nextRetryAt: nextRetryAt.toISOString(),
    lastError: error,
    lastAttemptAt: now.toISOString(),
  };
}

export function shouldRetry(state: BindingRuntimeState, now: Date = new Date()): boolean {
  if (state.retryAttempt === 0) {
    return true;
  }

  if (!state.nextRetryAt) {
    return true;
  }

  const nextRetryTime = Date.parse(state.nextRetryAt);
  if (Number.isNaN(nextRetryTime)) {
    return true;
  }

  return now.getTime() >= nextRetryTime;
}

export function createInMemoryBindingRuntimeStore(): BindingRuntimeStore {
  const states = new Map<IntegrationBinding["id"], BindingRuntimeState>();

  return {
    get(bindingId): BindingRuntimeState | null {
      const state = states.get(bindingId);
      return state ? { ...state } : null;
    },
    save(state): void {
      states.set(state.bindingId, { ...state });
    },
    remove(bindingId): void {
      states.delete(bindingId);
    },
    listAll(): BindingRuntimeState[] {
      return [...states.values()].map((s) => ({ ...s }));
    },
  };
}

export function createFileBindingRuntimeStore(storagePath: string): BindingRuntimeStore {
  const readStates = (): BindingRuntimeState[] => {
    if (!fs.existsSync(storagePath)) {
      return [];
    }

    const rawContent = fs.readFileSync(storagePath, "utf8");
    if (!rawContent.trim()) {
      return [];
    }

    const parsedContent = JSON.parse(rawContent) as unknown;
    if (!Array.isArray(parsedContent)) {
      throw new Error(`Invalid binding runtime store at ${storagePath}: expected JSON array`);
    }

    return parsedContent.map((entry) => {
      if (!entry || typeof entry !== "object") {
        throw new Error(`Invalid binding runtime store at ${storagePath}: invalid state record`);
      }

      return entry as BindingRuntimeState;
    });
  };

  const writeStates = (states: BindingRuntimeState[]): void => {
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, `${JSON.stringify(states, null, 2)}\n`, "utf8");
  };

  return {
    get(bindingId): BindingRuntimeState | null {
      return readStates().find((s) => s.bindingId === bindingId) ?? null;
    },
    save(state): void {
      const existing = readStates().filter((s) => s.bindingId !== state.bindingId);
      existing.push(state);
      writeStates(existing);
    },
    remove(bindingId): void {
      const existing = readStates().filter((s) => s.bindingId !== bindingId);
      writeStates(existing);
    },
    listAll(): BindingRuntimeState[] {
      return readStates();
    },
  };
}
