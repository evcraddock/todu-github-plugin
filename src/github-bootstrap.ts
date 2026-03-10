import type { ExternalTask, IntegrationBinding, Project, Task } from "@todu/core";

import type { GitHubIssue, GitHubIssueClient } from "@/github-client";
import {
  createLinkFromIssue,
  createLinkFromTask,
  type GitHubItemLink,
  type GitHubItemLinkStore,
} from "@/github-links";
import { formatIssueExternalId, parseIssueExternalId } from "@/github-ids";

const TASK_BOOTSTRAP_EXPORT_STATUSES = new Set<Task["status"]>(["active", "inprogress", "waiting"]);

export interface GitHubBootstrapImportResult {
  tasks: ExternalTask[];
  createdLinks: GitHubItemLink[];
}

export interface GitHubBootstrapTaskUpdate {
  taskId: Task["id"];
  externalId: string;
  sourceUrl?: string;
}

export interface GitHubBootstrapExportResult {
  createdIssues: GitHubIssue[];
  createdLinks: GitHubItemLink[];
  taskUpdates: GitHubBootstrapTaskUpdate[];
}

export async function bootstrapGitHubIssuesToTasks(input: {
  binding: IntegrationBinding;
  owner: string;
  repo: string;
  project: Project;
  issueClient: GitHubIssueClient;
  linkStore: GitHubItemLinkStore;
}): Promise<GitHubBootstrapImportResult> {
  const issues = await input.issueClient.listOpenIssues({
    owner: input.owner,
    repo: input.repo,
  });

  const tasks: ExternalTask[] = [];
  const createdLinks: GitHubItemLink[] = [];

  for (const issue of issues) {
    if (issue.state !== "open" || issue.isPullRequest) {
      continue;
    }

    const existingLink = input.linkStore.getByIssueNumber(input.binding.id, issue.number);
    if (existingLink) {
      continue;
    }

    const externalId = formatIssueExternalId({
      owner: input.owner,
      repo: input.repo,
      issueNumber: issue.number,
    });

    tasks.push({
      externalId,
      title: issue.title,
      description: issue.body,
      labels: [...issue.labels],
      sourceUrl: issue.sourceUrl,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      raw: issue,
    });

    const createdLink = createLinkFromIssue(input.binding, issue, input.owner, input.repo);
    input.linkStore.save(createdLink);
    createdLinks.push(createdLink);
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
  tasks: Task[];
  issueClient: GitHubIssueClient;
  linkStore: GitHubItemLinkStore;
}): Promise<GitHubBootstrapExportResult> {
  const createdIssues: GitHubIssue[] = [];
  const createdLinks: GitHubItemLink[] = [];
  const taskUpdates: GitHubBootstrapTaskUpdate[] = [];

  for (const task of input.tasks) {
    if (!TASK_BOOTSTRAP_EXPORT_STATUSES.has(task.status)) {
      continue;
    }

    const existingLink = input.linkStore.getByTaskId(input.binding.id, task.id);
    if (existingLink) {
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
      continue;
    }

    const createdIssue = await input.issueClient.createIssue(
      {
        owner: input.owner,
        repo: input.repo,
      },
      task
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
    createdLinks,
    taskUpdates,
  };
}

function createIssueSourceUrl(owner: string, repo: string, issueNumber: number): string {
  return `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
}

function getMatchingExternalId(
  task: Task,
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
