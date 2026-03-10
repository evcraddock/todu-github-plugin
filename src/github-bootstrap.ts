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
}

export async function bootstrapGitHubIssuesToTasks(input: {
  binding: IntegrationBinding;
  owner: string;
  repo: string;
  issueClient: GitHubIssueClient;
  linkStore: GitHubItemLinkStore;
}): Promise<GitHubBootstrapImportResult> {
  const issues = await input.issueClient.listIssues({
    owner: input.owner,
    repo: input.repo,
  });

  const tasks: ExternalTask[] = [];
  const createdLinks: GitHubItemLink[] = [];

  for (const issue of issues) {
    if (issue.isPullRequest) {
      continue;
    }

    const existingLink = input.linkStore.getByIssueNumber(input.binding.id, issue.number);
    if (!existingLink && issue.state !== "open") {
      continue;
    }

    if (!existingLink) {
      const createdLink = createLinkFromIssue(input.binding, issue, input.owner, input.repo);
      input.linkStore.save(createdLink);
      createdLinks.push(createdLink);
    }

    tasks.push(mapGitHubIssueToExternalTask(issue));
  }

  return {
    tasks,
    createdLinks,
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

  for (const task of input.tasks) {
    const existingLink = input.linkStore.getByTaskId(input.binding.id, task.id);
    if (existingLink) {
      const existingIssue = await input.issueClient.getIssue(
        {
          owner: input.owner,
          repo: input.repo,
        },
        existingLink.issueNumber
      );
      task.externalId = existingLink.externalId;
      task.sourceUrl = existingIssue?.sourceUrl ?? task.sourceUrl;

      if (shouldPushTaskUpdate(task, existingIssue)) {
        const updatedIssue = await input.issueClient.updateIssue(
          {
            owner: input.owner,
            repo: input.repo,
          },
          existingLink.issueNumber,
          createGitHubIssueUpdateFromTask(task)
        );
        task.sourceUrl = updatedIssue.sourceUrl;
        updatedIssues.push(updatedIssue);
      }
      continue;
    }

    const matchingExternalId = getMatchingExternalId(task, input.owner, input.repo);
    if (matchingExternalId) {
      const createdLink = createLinkFromTask(
        input.binding,
        task.id,
        input.owner,
        input.repo,
        matchingExternalId.issueNumber
      );
      task.externalId = createdLink.externalId;
      task.sourceUrl ??= createIssueSourceUrl(
        input.owner,
        input.repo,
        matchingExternalId.issueNumber
      );
      input.linkStore.save(createdLink);
      createdLinks.push(createdLink);

      const existingIssue = await input.issueClient.getIssue(
        {
          owner: input.owner,
          repo: input.repo,
        },
        matchingExternalId.issueNumber
      );
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
      createdIssue.number
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
  };
}

function createIssueSourceUrl(owner: string, repo: string, issueNumber: number): string {
  return `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
}

function shouldPushTaskUpdate(task: TaskPushPayload, issue: GitHubIssue | null): boolean {
  if (!issue?.updatedAt) {
    return true;
  }

  const taskUpdatedAt = Date.parse(task.updatedAt);
  const issueUpdatedAt = Date.parse(issue.updatedAt);

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
