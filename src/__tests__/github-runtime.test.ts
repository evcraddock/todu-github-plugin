import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createIntegrationBindingId } from "@todu/core";
import { describe, expect, it } from "vitest";

import {
  computeNextRetryDelay,
  createFileBindingRuntimeStore,
  createInMemoryBindingRuntimeStore,
  createInitialRuntimeState,
  recordFailure,
  recordSuccess,
  shouldRetry,
  type RetryConfig,
} from "@/index";

const BINDING_ID = createIntegrationBindingId("binding-rt-1");

describe("createInitialRuntimeState", () => {
  it("creates a clean runtime state with no retry or cursor", () => {
    const state = createInitialRuntimeState(BINDING_ID);

    expect(state).toEqual({
      bindingId: BINDING_ID,
      cursor: null,
      retryAttempt: 0,
      nextRetryAt: null,
      lastError: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
    });
  });
});

describe("computeNextRetryDelay", () => {
  const config: RetryConfig = { initialSeconds: 5, maxSeconds: 300 };

  it("returns 0 for attempt 0", () => {
    expect(computeNextRetryDelay(0, config)).toBe(0);
  });

  it("returns initialSeconds for first attempt", () => {
    expect(computeNextRetryDelay(1, config)).toBe(5);
  });

  it("doubles delay for each subsequent attempt", () => {
    expect(computeNextRetryDelay(2, config)).toBe(10);
    expect(computeNextRetryDelay(3, config)).toBe(20);
    expect(computeNextRetryDelay(4, config)).toBe(40);
  });

  it("caps delay at maxSeconds", () => {
    expect(computeNextRetryDelay(10, config)).toBe(300);
    expect(computeNextRetryDelay(20, config)).toBe(300);
  });
});

describe("recordSuccess", () => {
  it("resets retry state and records success timestamp", () => {
    const now = new Date("2026-03-10T12:00:00.000Z");
    const failedState = recordFailure(
      createInitialRuntimeState(BINDING_ID),
      "network error",
      undefined,
      new Date("2026-03-10T11:00:00.000Z")
    );

    const successState = recordSuccess(failedState, "cursor-abc", now);

    expect(successState.retryAttempt).toBe(0);
    expect(successState.nextRetryAt).toBeNull();
    expect(successState.lastError).toBeNull();
    expect(successState.cursor).toBe("cursor-abc");
    expect(successState.lastSuccessAt).toBe("2026-03-10T12:00:00.000Z");
    expect(successState.lastAttemptAt).toBe("2026-03-10T12:00:00.000Z");
  });

  it("preserves binding identity", () => {
    const state = recordSuccess(createInitialRuntimeState(BINDING_ID), null);
    expect(state.bindingId).toBe(BINDING_ID);
  });
});

describe("recordFailure", () => {
  const config: RetryConfig = { initialSeconds: 5, maxSeconds: 300 };

  it("increments retry attempt and sets next retry time", () => {
    const now = new Date("2026-03-10T12:00:00.000Z");
    const state = recordFailure(createInitialRuntimeState(BINDING_ID), "API error", config, now);

    expect(state.retryAttempt).toBe(1);
    expect(state.lastError).toBe("API error");
    expect(state.lastAttemptAt).toBe("2026-03-10T12:00:00.000Z");
    expect(state.nextRetryAt).toBe("2026-03-10T12:00:05.000Z");
  });

  it("uses exponential backoff for subsequent failures", () => {
    const now1 = new Date("2026-03-10T12:00:00.000Z");
    const state1 = recordFailure(createInitialRuntimeState(BINDING_ID), "error 1", config, now1);
    expect(state1.nextRetryAt).toBe("2026-03-10T12:00:05.000Z");

    const now2 = new Date("2026-03-10T12:00:05.000Z");
    const state2 = recordFailure(state1, "error 2", config, now2);
    expect(state2.retryAttempt).toBe(2);
    expect(state2.nextRetryAt).toBe("2026-03-10T12:00:15.000Z");

    const now3 = new Date("2026-03-10T12:00:15.000Z");
    const state3 = recordFailure(state2, "error 3", config, now3);
    expect(state3.retryAttempt).toBe(3);
    expect(state3.nextRetryAt).toBe("2026-03-10T12:00:35.000Z");
  });

  it("caps retry delay at maxSeconds", () => {
    let state = createInitialRuntimeState(BINDING_ID);
    const now = new Date("2026-03-10T12:00:00.000Z");

    for (let i = 0; i < 15; i++) {
      state = recordFailure(state, "persistent error", config, now);
    }

    const delay = computeNextRetryDelay(state.retryAttempt, config);
    expect(delay).toBe(300);
  });

  it("accepts an explicit retryAt override", () => {
    const now = new Date("2026-03-10T12:00:00.000Z");
    const retryAt = new Date("2026-03-10T12:30:00.000Z");

    const state = recordFailure(createInitialRuntimeState(BINDING_ID), "rate limit", config, now, {
      retryAt,
    });

    expect(state.retryAttempt).toBe(1);
    expect(state.nextRetryAt).toBe("2026-03-10T12:30:00.000Z");
  });

  it("accepts an explicit delay override", () => {
    const now = new Date("2026-03-10T12:00:00.000Z");

    const state = recordFailure(createInitialRuntimeState(BINDING_ID), "rate limit", config, now, {
      delaySeconds: 900,
    });

    expect(state.retryAttempt).toBe(1);
    expect(state.nextRetryAt).toBe("2026-03-10T12:15:00.000Z");
  });
});

describe("shouldRetry", () => {
  it("returns true when no retry is pending", () => {
    expect(shouldRetry(createInitialRuntimeState(BINDING_ID))).toBe(true);
  });

  it("returns false when retry time has not arrived", () => {
    const now = new Date("2026-03-10T12:00:00.000Z");
    const state = recordFailure(
      createInitialRuntimeState(BINDING_ID),
      "error",
      { initialSeconds: 60, maxSeconds: 300 },
      now
    );

    expect(shouldRetry(state, new Date("2026-03-10T12:00:30.000Z"))).toBe(false);
  });

  it("returns true when retry time has arrived", () => {
    const now = new Date("2026-03-10T12:00:00.000Z");
    const state = recordFailure(
      createInitialRuntimeState(BINDING_ID),
      "error",
      { initialSeconds: 5, maxSeconds: 300 },
      now
    );

    expect(shouldRetry(state, new Date("2026-03-10T12:00:05.000Z"))).toBe(true);
  });

  it("returns true when retry time has passed", () => {
    const now = new Date("2026-03-10T12:00:00.000Z");
    const state = recordFailure(
      createInitialRuntimeState(BINDING_ID),
      "error",
      { initialSeconds: 5, maxSeconds: 300 },
      now
    );

    expect(shouldRetry(state, new Date("2026-03-10T12:01:00.000Z"))).toBe(true);
  });
});

describe("createInMemoryBindingRuntimeStore", () => {
  it("stores and retrieves runtime state by binding ID", () => {
    const store = createInMemoryBindingRuntimeStore();
    const state = createInitialRuntimeState(BINDING_ID);

    store.save(state);

    expect(store.get(BINDING_ID)).toEqual(state);
  });

  it("returns null for unknown binding ID", () => {
    const store = createInMemoryBindingRuntimeStore();
    expect(store.get(createIntegrationBindingId("unknown"))).toBeNull();
  });

  it("overwrites existing state on save", () => {
    const store = createInMemoryBindingRuntimeStore();
    const initial = createInitialRuntimeState(BINDING_ID);
    store.save(initial);

    const updated = recordSuccess(initial, "cursor-1");
    store.save(updated);

    expect(store.get(BINDING_ID)?.cursor).toBe("cursor-1");
  });

  it("removes state by binding ID", () => {
    const store = createInMemoryBindingRuntimeStore();
    store.save(createInitialRuntimeState(BINDING_ID));
    store.remove(BINDING_ID);

    expect(store.get(BINDING_ID)).toBeNull();
  });

  it("lists all stored states", () => {
    const store = createInMemoryBindingRuntimeStore();
    const id1 = createIntegrationBindingId("b1");
    const id2 = createIntegrationBindingId("b2");
    store.save(createInitialRuntimeState(id1));
    store.save(createInitialRuntimeState(id2));

    expect(store.listAll()).toHaveLength(2);
  });

  it("returns copies so mutations do not affect store", () => {
    const store = createInMemoryBindingRuntimeStore();
    const state = createInitialRuntimeState(BINDING_ID);
    store.save(state);

    const retrieved = store.get(BINDING_ID)!;
    retrieved.cursor = "mutated";

    expect(store.get(BINDING_ID)?.cursor).toBeNull();
  });
});

describe("createFileBindingRuntimeStore", () => {
  it("persists and retrieves runtime state from disk", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "todu-rt-"));
    const storagePath = path.join(tempDir, "runtime.json");
    const store = createFileBindingRuntimeStore(storagePath);

    const state = recordSuccess(createInitialRuntimeState(BINDING_ID), "cursor-file");
    store.save(state);

    const store2 = createFileBindingRuntimeStore(storagePath);
    const loaded = store2.get(BINDING_ID);

    expect(loaded?.cursor).toBe("cursor-file");
    expect(loaded?.retryAttempt).toBe(0);
  });

  it("returns null when storage file does not exist", () => {
    const storagePath = path.join(os.tmpdir(), "nonexistent-rt-store.json");
    const store = createFileBindingRuntimeStore(storagePath);

    expect(store.get(BINDING_ID)).toBeNull();
  });

  it("removes state and persists the change", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "todu-rt-"));
    const storagePath = path.join(tempDir, "runtime.json");
    const store = createFileBindingRuntimeStore(storagePath);

    store.save(createInitialRuntimeState(BINDING_ID));
    store.remove(BINDING_ID);

    const store2 = createFileBindingRuntimeStore(storagePath);
    expect(store2.get(BINDING_ID)).toBeNull();
  });
});
