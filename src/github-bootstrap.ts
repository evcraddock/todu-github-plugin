import type { ExportedTaskInput, ImportedTaskInput, IntegrationBinding } from "@todu/core";

import type { GitHubIssue, GitHubIssueClient } from "@/github-client";
import {
  createGitHubIssueCreateFromTask,
  createGitHubIssueUpdateFromTask,
  mapGitHubIssueToImportedTask,
} from "@/github-fields";
import {
  createLinkFromIssue,
  createLinkFromTask,
  type GitHubItemLink,
  type GitHubItemLinkStore,
} from "@/github-links";
import { parseIssueExternalId } from "@/github-ids";

const TASK_BOOTSTRAP_EXPORT_STATUSES = new Set<ExportedTaskInput["status"]>([
  "active",
  "inprogress",
  "waiting",
]);

const DEFAULT_LINKED_ISSUE_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

export interface GitHubBootstrapImportResult {
  tasks: ImportedTaskInput[];
  createdLinks: GitHubItemLink[];
  touchedIssueNumbers: number[];
}

export interface GitHubBootstrapTaskUpdate {
  taskId: ExportedTaskInput["localTaskId"];
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
  reconcileCheckedAt?: string;
  reconcileIntervalMs?: number;
}): Promise<GitHubBootstrapImportResult> {
  const issues = await input.issueClient.listIssues(
    { owner: input.owner, repo: input.repo },
    input.since ? { since: input.since } : undefined
  );

  const tasks: ImportedTaskInput[] = [];
  const createdLinks: GitHubItemLink[] = [];
  const touchedIssueNumbers: number[] = [];

  const listedIssueNumbers = new Set<number>();

  for (const issue of issues) {
    if (issue.isPullRequest) {
      continue;
    }

    listedIssueNumbers.add(issue.number);
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

    tasks.push(mapGitHubIssueToImportedTask(issue));
    touchedIssueNumbers.push(issue.number);
  }

  if (input.since) {
    await reconcileLinkedIssues({
      binding: input.binding,
      owner: input.owner,
      repo: input.repo,
      issueClient: input.issueClient,
      linkStore: input.linkStore,
      listedIssueNumbers,
      since: input.since,
      checkedAt: input.reconcileCheckedAt ?? new Date().toISOString(),
      reconcileIntervalMs: input.reconcileIntervalMs ?? DEFAULT_LINKED_ISSUE_RECONCILE_INTERVAL_MS,
      tasks,
      touchedIssueNumbers,
    });
  }

  return {
    tasks,
    createdLinks,
    touchedIssueNumbers,
  };
}

async function reconcileLinkedIssues(input: {
  binding: IntegrationBinding;
  owner: string;
  repo: string;
  issueClient: GitHubIssueClient;
  linkStore: GitHubItemLinkStore;
  listedIssueNumbers: Set<number>;
  since: string;
  checkedAt: string;
  reconcileIntervalMs: number;
  tasks: ImportedTaskInput[];
  touchedIssueNumbers: number[];
}): Promise<void> {
  for (const link of input.linkStore.list(input.binding.id)) {
    if (input.listedIssueNumbers.has(link.issueNumber)) {
      continue;
    }

    if (
      !shouldReconcileLinkedIssue(link, input.since, input.checkedAt, input.reconcileIntervalMs)
    ) {
      continue;
    }

    const issue = await input.issueClient.getIssue(
      { owner: input.owner, repo: input.repo },
      link.issueNumber
    );

    if (!issue || issue.isPullRequest) {
      input.linkStore.save({ ...link, lastReconciledAt: input.checkedAt });
      continue;
    }

    const issueLastMirroredAt = issue.updatedAt ?? issue.createdAt;
    const remoteIssueIsNewer =
      issueLastMirroredAt != null && isRemoteIssueNewer(issueLastMirroredAt, link.lastMirroredAt);
    const updatedLink: GitHubItemLink = {
      ...link,
      lastReconciledAt: input.checkedAt,
      ...(issueLastMirroredAt && remoteIssueIsNewer ? { lastMirroredAt: issueLastMirroredAt } : {}),
    };
    input.linkStore.save(updatedLink);

    // First reconciliation pass records that the issue was checked. Later passes
    // periodically re-deliver linked issue state even when the remote timestamp did
    // not change, so a host-side import failure cannot permanently strand local state.
    if (!remoteIssueIsNewer && !link.lastReconciledAt) {
      continue;
    }

    input.tasks.push(mapGitHubIssueToImportedTask(issue));
    input.touchedIssueNumbers.push(issue.number);
  }
}

function shouldReconcileLinkedIssue(
  link: GitHubItemLink,
  since: string,
  checkedAt: string,
  reconcileIntervalMs: number
): boolean {
  if (!link.lastMirroredAt) {
    return true;
  }

  const sinceTime = Date.parse(since);
  const lastMirroredTime = Date.parse(link.lastMirroredAt);
  if (Number.isNaN(sinceTime) || Number.isNaN(lastMirroredTime)) {
    return true;
  }

  if (lastMirroredTime >= sinceTime) {
    return false;
  }

  if (!link.lastReconciledAt) {
    return true;
  }

  const checkedTime = Date.parse(checkedAt);
  const lastReconciledTime = Date.parse(link.lastReconciledAt);
  if (Number.isNaN(checkedTime) || Number.isNaN(lastReconciledTime)) {
    return true;
  }

  return checkedTime - lastReconciledTime >= reconcileIntervalMs;
}

function isRemoteIssueNewer(remoteUpdatedAt: string, lastMirroredAt: string | undefined): boolean {
  if (!lastMirroredAt) {
    return true;
  }

  const remoteTime = Date.parse(remoteUpdatedAt);
  const lastMirroredTime = Date.parse(lastMirroredAt);
  if (Number.isNaN(remoteTime) || Number.isNaN(lastMirroredTime)) {
    return remoteUpdatedAt !== lastMirroredAt;
  }

  return remoteTime > lastMirroredTime;
}

export async function bootstrapTasksToGitHubIssues(input: {
  binding: IntegrationBinding;
  owner: string;
  repo: string;
  tasks: ExportedTaskInput[];
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
    const existingLink = input.linkStore.getByTaskId(input.binding.id, task.localTaskId);
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
        task.localTaskId,
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
      task.localTaskId,
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
      taskId: task.localTaskId,
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

function shouldPushTaskUpdate(task: ExportedTaskInput, issue: GitHubIssue | null): boolean {
  if (!issue) {
    return true;
  }

  return shouldPushTaskUpdateFromMirroredAt(task, issue.updatedAt ?? issue.createdAt);
}

function shouldPushTaskUpdateFromMirroredAt(
  task: ExportedTaskInput,
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

  return taskUpdatedAt > issueUpdatedAt;
}

function getMatchingExternalId(
  task: ExportedTaskInput,
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
