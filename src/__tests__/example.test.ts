import { describe, expect, it } from "vitest";

import { formatIssueExternalId } from "@/index";

describe("formatIssueExternalId", () => {
  it("formats owner, repo, and issue number", () => {
    expect(formatIssueExternalId({ owner: "evcraddock", repo: "todu", issueNumber: 42 })).toBe(
      "evcraddock/todu#42"
    );
  });
});
