import { validateSyncProviderRegistration } from "@todu/core";
import { describe, expect, it } from "vitest";

import { formatIssueExternalId, syncProvider } from "@/index";

describe("formatIssueExternalId", () => {
  it("formats owner, repo, and issue number", () => {
    expect(formatIssueExternalId({ owner: "evcraddock", repo: "todu", issueNumber: 42 })).toBe(
      "evcraddock/todu#42"
    );
  });
});

describe("syncProvider registration", () => {
  it("exports a valid sync provider registration", () => {
    const result = validateSyncProviderRegistration(syncProvider);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`Expected sync provider registration to be valid: ${result.error.message}`);
    }

    expect(result.value.manifest.name).toBe("github");
    expect(result.value.manifest.apiVersion).toBe(2);
  });
});
