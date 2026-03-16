import type { ExternalTask, IntegrationBinding, TaskPushPayload } from "@todu/core";

import type { GitHubIssue, GitHubIssueClient } from "@/github-client";
import {
  createGitHubIssueCreateFromTask,
  createGitHubIssueUpdateFromTask,
  mapGitHubIssueToExternalTask,
} from "@/github-fields";
import {
  createLinkFromIssue,
  createLinkFromTask,
  type GitHubItemLink,
  type GitHubItemLinkStore,
} from "@/github-links";
import { parseIssueExternalId } from "@/github-ids";

const TASK_BOOTSTRAP_EXPORT_STATUSES = new Set<TaskPushPayload["status"]>([
  "active",
  "inprogress",
  "waiting",
]);

export interface GitHubBootstrapImportResult {
  tasks: ExternalTask[];
  createdLinks: GitHubItemLink[];
  touchedIssueNumbers: number[];
}

export interface GitHubBootstrapTaskUpdate {
  taskId: TaskPushPayload["id"];
  externalId: string;
  sourceUrl?: string;
}

export interface GitHubBootstrapExportResult {
  createdIssues: GitHubIssue[];
  updatedIssues: GitHubIssue[];
  createdLinks: GitHubItemLink[];
  taskUpdates: GitHubBootstrapTaskUpdate[];
  hydratedLinkedTasks: number;
  issueReadCount: number;
  skippedLinkedTasks: number;
}

export async function bootstrapGitHubIssuesToTasks(input: {
  binding: IntegrationBinding;
  owner: string;
  repo: string;
  issueClient: GitHubIssueClient;
  linkStore: GitHubItemLinkStore;
  since?: string;
  importClosedOnBootstrap?: boolean;
}): Promise<GitHubBootstrapImportResult> {
  const issues = await input.issueClient.listIssues(
    { owner: input.owner, repo: input.repo },
    input.since ? { since: input.since } : undefined
  );

  const tasks: ExternalTask[] = [];
  const createdLinks: GitHubItemLink[] = [];
  const touchedIssueNumbers: number[] = [];

  for (const issue of issues) {
    if (issue.isPullRequest) {
      continue;
    }

    const existingLink = input.linkStore.getByIssueNumber(input.binding.id, issue.number);
    if (!existingLink && issue.state !== "open" && !input.importClosedOnBootstrap) {
      continue;
    }

    const lastMirroredAt = issue.updatedAt ?? issue.createdAt;

    if (!existingLink) {
      const createdLink = createLinkFromIssue(input.binding, issue, input.owner, input.repo);
      input.linkStore.save(createdLink);
      createdLinks.push(createdLink);
    } else if (lastMirroredAt && existingLink.lastMirroredAt !== lastMirroredAt) {
      input.linkStore.save({
        ...existingLink,
        lastMirroredAt,
      });
    }

    tasks.push(mapGitHubIssueToExternalTask(issue));
    touchedIssueNumbers.push(issue.number);
  }

  return {
    tasks,
    createdLinks,
    touchedIssueNumbers,
  };
}

export async function bootstrapTasksToGitHubIssues(input: {
  binding: IntegrationBinding;
  owner: string;
  repo: string;
  tasks: TaskPushPayload[];
  issueClient: GitHubIssueClient;
  linkStore: GitHubItemLinkStore;
}): Promise<GitHubBootstrapExportResult> {
  const createdIssues: GitHubIssue[] = [];
  const updatedIssues: GitHubIssue[] = [];
  const createdLinks: GitHubItemLink[] = [];
  const taskUpdates: GitHubBootstrapTaskUpdate[] = [];
  let hydratedLinkedTasks = 0;
  let issueReadCount = 0;
  let skippedLinkedTasks = 0;

  for (const task of input.tasks) {
    const existingLink = input.linkStore.getByTaskId(input.binding.id, task.id);
    if (existingLink) {
      task.externalId = existingLink.externalId;
      task.sourceUrl ??= createIssueSourceUrl(input.owner, input.repo, existingLink.issueNumber);

      if (!existingLink.lastMirroredAt) {
        issueReadCount += 1;
        const existingIssue = await input.issueClient.getIssue(
          {
            owner: input.owner,
            repo: input.repo,
          },
          existingLink.issueNumber
        );
        hydratedLinkedTasks += 1;

        if (existingIssue) {
          const hydratedLink: GitHubItemLink = {
            ...existingLink,
            lastMirroredAt: existingIssue.updatedAt ?? existingIssue.createdAt,
          };
          input.linkStore.save(hydratedLink);

          if (!shouldPushTaskUpdate(task, existingIssue)) {
            skippedLinkedTasks += 1;
            continue;
          }
        }
      } else if (!shouldPushTaskUpdateFromMirroredAt(task, existingLink.lastMirroredAt)) {
        skippedLinkedTasks += 1;
        continue;
      }

      const updatedIssue = await input.issueClient.updateIssue(
        {
          owner: input.owner,
          repo: input.repo,
        },
        existingLink.issueNumber,
        createGitHubIssueUpdateFromTask(task)
      );
      task.sourceUrl = updatedIssue.sourceUrl;
      input.linkStore.save({
        ...existingLink,
        lastMirroredAt: updatedIssue.updatedAt ?? updatedIssue.createdAt,
      });
      updatedIssues.push(updatedIssue);
      continue;
    }

    const matchingExternalId = getMatchingExternalId(task, input.owner, input.repo);
    if (matchingExternalId) {
      issueReadCount += 1;
      const existingIssue = await input.issueClient.getIssue(
        {
          owner: input.owner,
          repo: input.repo,
        },
        matchingExternalId.issueNumber
      );
      const createdLink = createLinkFromTask(
        input.binding,
        task.id,
        input.owner,
        input.repo,
        matchingExternalId.issueNumber,
        existingIssue?.updatedAt ?? existingIssue?.createdAt
      );
      task.externalId = createdLink.externalId;
      task.sourceUrl ??=
        existingIssue?.sourceUrl ??
        createIssueSourceUrl(input.owner, input.repo, matchingExternalId.issueNumber);
      input.linkStore.save(createdLink);
      createdLinks.push(createdLink);

      if (shouldPushTaskUpdate(task, existingIssue)) {
        const updatedIssue = await input.issueClient.updateIssue(
          {
            owner: input.owner,
            repo: input.repo,
          },
          matchingExternalId.issueNumber,
          createGitHubIssueUpdateFromTask(task)
        );
        task.sourceUrl = updatedIssue.sourceUrl;
        input.linkStore.save({
          ...createdLink,
          lastMirroredAt: updatedIssue.updatedAt ?? updatedIssue.createdAt,
        });
        updatedIssues.push(updatedIssue);
      }
      continue;
    }

    if (!TASK_BOOTSTRAP_EXPORT_STATUSES.has(task.status)) {
      continue;
    }

    const createdIssue = await input.issueClient.createIssue(
      {
        owner: input.owner,
        repo: input.repo,
      },
      createGitHubIssueCreateFromTask(task)
    );

    createdIssues.push(createdIssue);

    const createdLink = createLinkFromTask(
      input.binding,
      task.id,
      input.owner,
      input.repo,
      createdIssue.number,
      createdIssue.updatedAt ?? createdIssue.createdAt
    );
    task.externalId = createdLink.externalId;
    task.sourceUrl = createdIssue.sourceUrl;
    input.linkStore.save(createdLink);
    createdLinks.push(createdLink);
    taskUpdates.push({
      taskId: task.id,
      externalId: createdLink.externalId,
      sourceUrl: createdIssue.sourceUrl,
    });
  }

  return {
    createdIssues,
    updatedIssues,
    createdLinks,
    taskUpdates,
    hydratedLinkedTasks,
    issueReadCount,
    skippedLinkedTasks,
  };
}

function createIssueSourceUrl(owner: string, repo: string, issueNumber: number): string {
  return `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
}

function shouldPushTaskUpdate(task: TaskPushPayload, issue: GitHubIssue | null): boolean {
  if (!issue) {
    return true;
  }

  return shouldPushTaskUpdateFromMirroredAt(task, issue.updatedAt ?? issue.createdAt);
}

function shouldPushTaskUpdateFromMirroredAt(
  task: TaskPushPayload,
  lastMirroredAt: string | undefined
): boolean {
  if (!lastMirroredAt) {
    return true;
  }

  const taskUpdatedAt = Date.parse(task.updatedAt);
  const issueUpdatedAt = Date.parse(lastMirroredAt);

  if (Number.isNaN(taskUpdatedAt) || Number.isNaN(issueUpdatedAt)) {
    return true;
  }

  return taskUpdatedAt >= issueUpdatedAt;
}

function getMatchingExternalId(
  task: TaskPushPayload,
  owner: string,
  repo: string
): { issueNumber: number } | null {
  if (!task.externalId) {
    return null;
  }

  try {
    const parsedExternalId = parseIssueExternalId(task.externalId);
    if (parsedExternalId.owner !== owner || parsedExternalId.repo !== repo) {
      return null;
    }

    return {
      issueNumber: parsedExternalId.issueNumber,
    };
  } catch {
    return null;
  }
}
