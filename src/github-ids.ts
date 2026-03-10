import { createTaskId, type Task } from "@todu/core";

export interface GitHubIssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
}

export class GitHubExternalIdError extends Error {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "GitHubExternalIdError";
    this.details = details;
  }
}

export function formatIssueExternalId(issue: GitHubIssueRef): string {
  return `${issue.owner}/${issue.repo}#${issue.issueNumber}`;
}

export function parseIssueExternalId(externalId: string): GitHubIssueRef {
  const normalizedExternalId = externalId.trim();
  if (!normalizedExternalId) {
    throw new GitHubExternalIdError("Invalid GitHub external_id: value is required", {
      externalId,
    });
  }

  const issueDelimiterIndex = normalizedExternalId.lastIndexOf("#");
  if (issueDelimiterIndex <= 0 || issueDelimiterIndex === normalizedExternalId.length - 1) {
    throw new GitHubExternalIdError(
      `Invalid GitHub external_id \`${externalId}\`: expected owner/repo#number format`,
      {
        externalId,
      }
    );
  }

  const targetRef = normalizedExternalId.slice(0, issueDelimiterIndex);
  const issueNumberText = normalizedExternalId.slice(issueDelimiterIndex + 1);
  const issueNumber = Number.parseInt(issueNumberText, 10);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new GitHubExternalIdError(
      `Invalid GitHub external_id \`${externalId}\`: issue number must be a positive integer`,
      {
        externalId,
        issueNumber: issueNumberText,
      }
    );
  }

  const [owner, repo, ...rest] = targetRef.split("/").map((segment) => segment.trim());
  if (!owner || !repo || rest.length > 0) {
    throw new GitHubExternalIdError(
      `Invalid GitHub external_id \`${externalId}\`: expected owner/repo#number format`,
      {
        externalId,
      }
    );
  }

  return {
    owner,
    repo,
    issueNumber,
  };
}

export function createImportedTaskId(externalId: string): Task["id"] {
  return createTaskId(`github:${externalId}`);
}
