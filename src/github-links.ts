import type { IntegrationBinding, Task } from "@todu/core";

import type { GitHubIssue } from "@/github-client";
import { createImportedTaskId, formatIssueExternalId } from "@/github-ids";

export interface GitHubItemLink {
  bindingId: IntegrationBinding["id"];
  taskId: Task["id"];
  issueNumber: number;
  externalId: string;
}

export interface GitHubItemLinkStore {
  getByTaskId(bindingId: IntegrationBinding["id"], taskId: Task["id"]): GitHubItemLink | null;
  getByIssueNumber(bindingId: IntegrationBinding["id"], issueNumber: number): GitHubItemLink | null;
  list(bindingId: IntegrationBinding["id"]): GitHubItemLink[];
  listAll(): GitHubItemLink[];
  save(link: GitHubItemLink): void;
}

export function createInMemoryGitHubItemLinkStore(): GitHubItemLinkStore {
  const links = new Map<string, GitHubItemLink>();

  const getTaskKey = (bindingId: IntegrationBinding["id"], taskId: Task["id"]): string =>
    `task:${bindingId}:${taskId}`;
  const getIssueKey = (bindingId: IntegrationBinding["id"], issueNumber: number): string =>
    `issue:${bindingId}:${issueNumber}`;

  return {
    getByTaskId(bindingId, taskId): GitHubItemLink | null {
      return links.get(getTaskKey(bindingId, taskId)) ?? null;
    },
    getByIssueNumber(bindingId, issueNumber): GitHubItemLink | null {
      return links.get(getIssueKey(bindingId, issueNumber)) ?? null;
    },
    list(bindingId): GitHubItemLink[] {
      const bindingLinks = new Map<string, GitHubItemLink>();

      for (const link of links.values()) {
        if (link.bindingId === bindingId) {
          bindingLinks.set(link.externalId, link);
        }
      }

      return [...bindingLinks.values()];
    },
    listAll(): GitHubItemLink[] {
      const allLinks = new Map<string, GitHubItemLink>();

      for (const link of links.values()) {
        allLinks.set(link.externalId, link);
      }

      return [...allLinks.values()];
    },
    save(link): void {
      links.set(getTaskKey(link.bindingId, link.taskId), link);
      links.set(getIssueKey(link.bindingId, link.issueNumber), link);
    },
  };
}

export function createLinkFromIssue(
  binding: IntegrationBinding,
  issue: GitHubIssue,
  owner: string,
  repo: string
): GitHubItemLink {
  const externalId = formatIssueExternalId({
    owner,
    repo,
    issueNumber: issue.number,
  });

  return {
    bindingId: binding.id,
    taskId: createImportedTaskId(externalId),
    issueNumber: issue.number,
    externalId,
  };
}

export function createLinkFromTask(
  binding: IntegrationBinding,
  taskId: Task["id"],
  owner: string,
  repo: string,
  issueNumber: number
): GitHubItemLink {
  return {
    bindingId: binding.id,
    taskId,
    issueNumber,
    externalId: formatIssueExternalId({ owner, repo, issueNumber }),
  };
}
