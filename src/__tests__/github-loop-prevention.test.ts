import { describe, expect, it } from "vitest";

import { createLoopPreventionStore, createWriteKey } from "@/index";

describe("createLoopPreventionStore", () => {
  it("records a write and recognizes it as own write", () => {
    const store = createLoopPreventionStore();
    store.recordWrite("issue:b1:42", "2026-03-10T12:00:00.000Z");

    expect(store.isOwnWrite("issue:b1:42", "2026-03-10T12:00:00.000Z")).toBe(true);
  });

  it("does not match different timestamps for the same key", () => {
    const store = createLoopPreventionStore();
    store.recordWrite("issue:b1:42", "2026-03-10T12:00:00.000Z");

    expect(store.isOwnWrite("issue:b1:42", "2026-03-10T13:00:00.000Z")).toBe(false);
  });

  it("does not match unknown keys", () => {
    const store = createLoopPreventionStore();

    expect(store.isOwnWrite("issue:b1:99", "2026-03-10T12:00:00.000Z")).toBe(false);
  });

  it("overwrites previous timestamp on re-record", () => {
    const store = createLoopPreventionStore();
    store.recordWrite("issue:b1:42", "2026-03-10T12:00:00.000Z");
    store.recordWrite("issue:b1:42", "2026-03-10T14:00:00.000Z");

    expect(store.isOwnWrite("issue:b1:42", "2026-03-10T12:00:00.000Z")).toBe(false);
    expect(store.isOwnWrite("issue:b1:42", "2026-03-10T14:00:00.000Z")).toBe(true);
  });

  it("clears expired entries", () => {
    const store = createLoopPreventionStore();
    store.recordWrite("issue:b1:1", "2026-03-10T10:00:00.000Z");
    store.recordWrite("issue:b1:2", "2026-03-10T12:00:00.000Z");

    const now = new Date("2026-03-10T12:05:00.000Z");
    const maxAgeMs = 10 * 60 * 1000; // 10 minutes
    store.clearExpired(maxAgeMs, now);

    expect(store.isOwnWrite("issue:b1:1", "2026-03-10T10:00:00.000Z")).toBe(false);
    expect(store.isOwnWrite("issue:b1:2", "2026-03-10T12:00:00.000Z")).toBe(true);
  });

  it("keeps entries within the max age window", () => {
    const store = createLoopPreventionStore();
    store.recordWrite("issue:b1:1", "2026-03-10T12:00:00.000Z");

    const now = new Date("2026-03-10T12:05:00.000Z");
    store.clearExpired(10 * 60 * 1000, now);

    expect(store.isOwnWrite("issue:b1:1", "2026-03-10T12:00:00.000Z")).toBe(true);
  });

  it("lists all recorded writes", () => {
    const store = createLoopPreventionStore();
    store.recordWrite("issue:b1:1", "2026-03-10T12:00:00.000Z");
    store.recordWrite("comment:b1:c1", "2026-03-10T12:01:00.000Z");

    const records = store.listAll();
    expect(records).toHaveLength(2);
    expect(records).toEqual(
      expect.arrayContaining([
        { key: "issue:b1:1", timestamp: "2026-03-10T12:00:00.000Z" },
        { key: "comment:b1:c1", timestamp: "2026-03-10T12:01:00.000Z" },
      ])
    );
  });
});

describe("createWriteKey", () => {
  it("creates a structured key for issues", () => {
    expect(createWriteKey("issue", "binding-1", "42")).toBe("issue:binding-1:42");
  });

  it("creates a structured key for comments", () => {
    expect(createWriteKey("comment", "binding-1", "c100")).toBe("comment:binding-1:c100");
  });
});
