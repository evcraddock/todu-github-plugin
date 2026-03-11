import type { IntegrationBinding } from "@todu/core";

export type BindingStatusState = "running" | "idle" | "blocked" | "error";

export interface BindingStatus {
  bindingId: IntegrationBinding["id"];
  state: BindingStatusState;
  authorityId: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastErrorSummary: string | null;
  updatedAt: string;
}

export function createBindingStatus(
  bindingId: IntegrationBinding["id"],
  authorityId: string | null = null,
  now: Date = new Date()
): BindingStatus {
  return {
    bindingId,
    state: "idle",
    authorityId,
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastErrorSummary: null,
    updatedAt: now.toISOString(),
  };
}

export function updateBindingStatusRunning(
  status: BindingStatus,
  now: Date = new Date()
): BindingStatus {
  return {
    ...status,
    state: "running",
    lastAttemptAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function updateBindingStatusIdle(
  status: BindingStatus,
  now: Date = new Date()
): BindingStatus {
  return {
    ...status,
    state: "idle",
    lastSuccessAt: now.toISOString(),
    lastAttemptAt: now.toISOString(),
    lastErrorSummary: null,
    updatedAt: now.toISOString(),
  };
}

export function updateBindingStatusError(
  status: BindingStatus,
  errorSummary: string,
  now: Date = new Date()
): BindingStatus {
  return {
    ...status,
    state: "error",
    lastAttemptAt: now.toISOString(),
    lastErrorSummary: errorSummary,
    updatedAt: now.toISOString(),
  };
}

export function updateBindingStatusBlocked(
  status: BindingStatus,
  reason: string,
  now: Date = new Date()
): BindingStatus {
  return {
    ...status,
    state: "blocked",
    lastErrorSummary: reason,
    updatedAt: now.toISOString(),
  };
}
