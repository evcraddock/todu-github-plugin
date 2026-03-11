import { createIntegrationBindingId } from "@todu/core";
import { describe, expect, it } from "vitest";

import {
  createBindingStatus,
  updateBindingStatusBlocked,
  updateBindingStatusError,
  updateBindingStatusIdle,
  updateBindingStatusRunning,
} from "@/index";

const BINDING_ID = createIntegrationBindingId("binding-status-1");
const NOW = new Date("2026-03-10T12:00:00.000Z");

describe("createBindingStatus", () => {
  it("creates an idle binding status with no history", () => {
    const status = createBindingStatus(BINDING_ID, "daemon-1", NOW);

    expect(status).toEqual({
      bindingId: BINDING_ID,
      state: "idle",
      authorityId: "daemon-1",
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastErrorSummary: null,
      updatedAt: "2026-03-10T12:00:00.000Z",
    });
  });

  it("defaults authorityId to null", () => {
    const status = createBindingStatus(BINDING_ID);
    expect(status.authorityId).toBeNull();
  });
});

describe("updateBindingStatusRunning", () => {
  it("transitions to running and records attempt time", () => {
    const initial = createBindingStatus(BINDING_ID, "daemon-1", NOW);
    const running = updateBindingStatusRunning(initial, NOW);

    expect(running.state).toBe("running");
    expect(running.lastAttemptAt).toBe("2026-03-10T12:00:00.000Z");
    expect(running.updatedAt).toBe("2026-03-10T12:00:00.000Z");
  });

  it("preserves previous success timestamp", () => {
    const idle = updateBindingStatusIdle(
      createBindingStatus(BINDING_ID, "daemon-1", NOW),
      new Date("2026-03-10T11:00:00.000Z")
    );
    const running = updateBindingStatusRunning(idle, NOW);

    expect(running.lastSuccessAt).toBe("2026-03-10T11:00:00.000Z");
  });
});

describe("updateBindingStatusIdle", () => {
  it("transitions to idle and records success", () => {
    const running = updateBindingStatusRunning(
      createBindingStatus(BINDING_ID, "daemon-1", NOW),
      NOW
    );
    const idle = updateBindingStatusIdle(running, new Date("2026-03-10T12:05:00.000Z"));

    expect(idle.state).toBe("idle");
    expect(idle.lastSuccessAt).toBe("2026-03-10T12:05:00.000Z");
    expect(idle.lastAttemptAt).toBe("2026-03-10T12:05:00.000Z");
    expect(idle.lastErrorSummary).toBeNull();
  });

  it("clears previous error summary on success", () => {
    const errorState = updateBindingStatusError(
      createBindingStatus(BINDING_ID, "daemon-1", NOW),
      "API rate limit",
      NOW
    );
    const idle = updateBindingStatusIdle(errorState, new Date("2026-03-10T12:10:00.000Z"));

    expect(idle.lastErrorSummary).toBeNull();
  });
});

describe("updateBindingStatusError", () => {
  it("transitions to error with summary and attempt time", () => {
    const running = updateBindingStatusRunning(
      createBindingStatus(BINDING_ID, "daemon-1", NOW),
      NOW
    );
    const errorState = updateBindingStatusError(
      running,
      "GitHub API rate limit exceeded",
      new Date("2026-03-10T12:05:00.000Z")
    );

    expect(errorState.state).toBe("error");
    expect(errorState.lastErrorSummary).toBe("GitHub API rate limit exceeded");
    expect(errorState.lastAttemptAt).toBe("2026-03-10T12:05:00.000Z");
  });

  it("preserves previous success timestamp through error", () => {
    const idle = updateBindingStatusIdle(
      createBindingStatus(BINDING_ID, "daemon-1", NOW),
      new Date("2026-03-10T11:00:00.000Z")
    );
    const errorState = updateBindingStatusError(idle, "timeout", NOW);

    expect(errorState.lastSuccessAt).toBe("2026-03-10T11:00:00.000Z");
  });
});

describe("updateBindingStatusBlocked", () => {
  it("transitions to blocked with reason", () => {
    const initial = createBindingStatus(BINDING_ID, "daemon-1", NOW);
    const blocked = updateBindingStatusBlocked(
      initial,
      "binding disabled",
      new Date("2026-03-10T12:05:00.000Z")
    );

    expect(blocked.state).toBe("blocked");
    expect(blocked.lastErrorSummary).toBe("binding disabled");
    expect(blocked.updatedAt).toBe("2026-03-10T12:05:00.000Z");
  });
});

describe("binding status lifecycle", () => {
  it("follows idle → running → idle cycle on success", () => {
    let status = createBindingStatus(BINDING_ID, "daemon-1", NOW);
    expect(status.state).toBe("idle");

    status = updateBindingStatusRunning(status, new Date("2026-03-10T12:00:00.000Z"));
    expect(status.state).toBe("running");

    status = updateBindingStatusIdle(status, new Date("2026-03-10T12:01:00.000Z"));
    expect(status.state).toBe("idle");
    expect(status.lastSuccessAt).toBe("2026-03-10T12:01:00.000Z");
  });

  it("follows idle → running → error → running → idle cycle on retry success", () => {
    let status = createBindingStatus(BINDING_ID, "daemon-1", NOW);

    status = updateBindingStatusRunning(status, new Date("2026-03-10T12:00:00.000Z"));
    status = updateBindingStatusError(status, "timeout", new Date("2026-03-10T12:00:30.000Z"));
    expect(status.state).toBe("error");

    status = updateBindingStatusRunning(status, new Date("2026-03-10T12:05:00.000Z"));
    status = updateBindingStatusIdle(status, new Date("2026-03-10T12:05:30.000Z"));
    expect(status.state).toBe("idle");
    expect(status.lastSuccessAt).toBe("2026-03-10T12:05:30.000Z");
    expect(status.lastErrorSummary).toBeNull();
  });
});
