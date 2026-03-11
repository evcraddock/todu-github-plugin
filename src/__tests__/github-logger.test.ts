import { createIntegrationBindingId } from "@todu/core";
import { describe, expect, it } from "vitest";

import { createGitHubSyncLogger, formatLogEntry, type SyncLogContext } from "@/index";

const BINDING_ID = createIntegrationBindingId("binding-log-1");

describe("createGitHubSyncLogger", () => {
  it("records log entries with correct level", () => {
    const logger = createGitHubSyncLogger();
    const context: SyncLogContext = { bindingId: BINDING_ID };

    logger.debug("debug message", context);
    logger.info("info message", context);
    logger.warn("warn message", context);
    logger.error("error message", context, "some error");

    const entries = logger.getEntries();
    expect(entries).toHaveLength(4);
    expect(entries[0].level).toBe("debug");
    expect(entries[1].level).toBe("info");
    expect(entries[2].level).toBe("warn");
    expect(entries[3].level).toBe("error");
    expect(entries[3].error).toBe("some error");
  });

  it("captures full context fields", () => {
    const logger = createGitHubSyncLogger();
    const context: SyncLogContext = {
      bindingId: BINDING_ID,
      projectId: "project-1",
      repo: "evcraddock/todu",
      direction: "pull",
      entityType: "issue",
      itemId: "42",
    };

    logger.info("pulled issue", context);

    const entry = logger.getEntries()[0];
    expect(entry.context).toEqual(context);
    expect(entry.message).toBe("pulled issue");
    expect(entry.timestamp).toBeTruthy();
  });

  it("returns copies so mutations do not affect stored entries", () => {
    const logger = createGitHubSyncLogger();
    logger.info("test", { bindingId: BINDING_ID });

    const entries = logger.getEntries();
    entries[0].message = "mutated";

    expect(logger.getEntries()[0].message).toBe("test");
  });

  it("captures error field only for error level", () => {
    const logger = createGitHubSyncLogger();
    logger.info("no error", { bindingId: BINDING_ID });
    logger.error("with error", { bindingId: BINDING_ID }, "details");

    expect(logger.getEntries()[0].error).toBeUndefined();
    expect(logger.getEntries()[1].error).toBe("details");
  });
});

describe("formatLogEntry", () => {
  it("formats a minimal log entry", () => {
    const formatted = formatLogEntry({
      level: "info",
      message: "sync started",
      context: { bindingId: BINDING_ID },
      timestamp: "2026-03-10T12:00:00.000Z",
    });

    expect(formatted).toContain("[2026-03-10T12:00:00.000Z]");
    expect(formatted).toContain("[INFO]");
    expect(formatted).toContain(`[binding:${BINDING_ID}]`);
    expect(formatted).toContain("sync started");
  });

  it("includes all optional context fields when present", () => {
    const formatted = formatLogEntry({
      level: "error",
      message: "failed to update issue",
      context: {
        bindingId: BINDING_ID,
        repo: "evcraddock/todu",
        direction: "push",
        entityType: "issue",
        itemId: "evcraddock/todu#42",
      },
      error: "API timeout",
      timestamp: "2026-03-10T12:00:00.000Z",
    });

    expect(formatted).toContain("[repo:evcraddock/todu]");
    expect(formatted).toContain("[push]");
    expect(formatted).toContain("[issue]");
    expect(formatted).toContain("[item:evcraddock/todu#42]");
    expect(formatted).toContain("failed to update issue");
    expect(formatted).toContain("| error: API timeout");
  });

  it("omits optional fields when not present", () => {
    const formatted = formatLogEntry({
      level: "debug",
      message: "checkpoint saved",
      context: { bindingId: BINDING_ID },
      timestamp: "2026-03-10T12:00:00.000Z",
    });

    expect(formatted).not.toContain("[repo:");
    expect(formatted).not.toContain("[pull]");
    expect(formatted).not.toContain("[push]");
    expect(formatted).not.toContain("[item:");
    expect(formatted).not.toContain("| error:");
  });
});
