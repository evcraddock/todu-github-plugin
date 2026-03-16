import fs from "node:fs";
import path from "node:path";

import type { IntegrationBinding, Task } from "@todu/core";

import type { GitHubIssue } from "@/github-client";
import { createImportedTaskId, formatIssueExternalId } from "@/github-ids";

export interface GitHubItemLink {
  bindingId: IntegrationBinding["id"];
  taskId: Task["id"];
  issueNumber: number;
  externalId: string;
  lastMirroredAt?: string;
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

export function createFileGitHubItemLinkStore(storagePath: string): GitHubItemLinkStore {
  const readLinks = (): GitHubItemLink[] => {
    if (!fs.existsSync(storagePath)) {
      return [];
    }

    const rawContent = fs.readFileSync(storagePath, "utf8");
    if (!rawContent.trim()) {
      return [];
    }

    const parsedContent = JSON.parse(rawContent) as unknown;
    if (!Array.isArray(parsedContent)) {
      throw new Error(`Invalid GitHub item link store at ${storagePath}: expected JSON array`);
    }

    return parsedContent.map((link) => {
      if (!link || typeof link !== "object") {
        throw new Error(`Invalid GitHub item link store at ${storagePath}: invalid link record`);
      }

      return link as GitHubItemLink;
    });
  };

  const writeLinks = (links: GitHubItemLink[]): void => {
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, `${JSON.stringify(links, null, 2)}\n`, "utf8");
  };

  const getLink = (predicate: (link: GitHubItemLink) => boolean): GitHubItemLink | null =>
    readLinks().find(predicate) ?? null;

  return {
    getByTaskId(bindingId, taskId): GitHubItemLink | null {
      return getLink((link) => link.bindingId === bindingId && link.taskId === taskId);
    },
    getByIssueNumber(bindingId, issueNumber): GitHubItemLink | null {
      return getLink((link) => link.bindingId === bindingId && link.issueNumber === issueNumber);
    },
    list(bindingId): GitHubItemLink[] {
      return readLinks().filter((link) => link.bindingId === bindingId);
    },
    listAll(): GitHubItemLink[] {
      return readLinks();
    },
    save(link): void {
      const existingLinks = readLinks().filter(
        (existingLink) =>
          !(
            existingLink.bindingId === link.bindingId &&
            (existingLink.taskId === link.taskId || existingLink.issueNumber === link.issueNumber)
          )
      );
      existingLinks.push(link);
      writeLinks(existingLinks);
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
    lastMirroredAt: issue.updatedAt ?? issue.createdAt,
  };
}

export function createLinkFromTask(
  binding: IntegrationBinding,
  taskId: Task["id"],
  owner: string,
  repo: string,
  issueNumber: number,
  lastMirroredAt?: string
): GitHubItemLink {
  return {
    bindingId: binding.id,
    taskId,
    issueNumber,
    externalId: formatIssueExternalId({ owner, repo, issueNumber }),
    ...(lastMirroredAt ? { lastMirroredAt } : {}),
  };
}
