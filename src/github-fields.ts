import type { ExternalTask, Task, TaskStatus, TaskWithDetail } from "@todu/core";

import type { CreateGitHubIssueInput, GitHubIssue, UpdateGitHubIssueInput } from "@/github-client";

const OPEN_STATUS_PRECEDENCE: TaskStatus[] = ["active", "inprogress", "waiting"];
const CLOSED_STATUS_PRECEDENCE: TaskStatus[] = ["done", "canceled"];
const PRIORITY_PRECEDENCE: Task["priority"][] = ["high", "medium", "low"];

export const STATUS_LABEL_PREFIX = "status:";
export const PRIORITY_LABEL_PREFIX = "priority:";

export interface NormalizedGitHubStatus {
  status: TaskStatus;
  state: GitHubIssue["state"];
  statusLabel: string;
}

export interface NormalizedGitHubPriority {
  priority: Task["priority"];
  priorityLabel: string;
}

export interface GitHubFieldMapping {
  title: string;
  description?: string;
  status: TaskStatus;
  priority: Task["priority"];
  labels: string[];
  assignees: string[];
}

export function mapGitHubIssueToExternalTask(issue: GitHubIssue): ExternalTask {
  const normalizedStatus = normalizeGitHubIssueStatus(issue.state, issue.labels);
  const normalizedPriority = normalizeGitHubIssuePriority(issue.labels);

  return {
    externalId: issue.externalId,
    title: issue.title,
    description: issue.body,
    status: normalizedStatus.status,
    priority: normalizedPriority.priority,
    labels: getNormalGitHubLabels(issue.labels),
    assignees: [...issue.assignees],
    sourceUrl: issue.sourceUrl,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    raw: issue,
  };
}

export function createGitHubIssueCreateFromTask(task: TaskWithDetail): CreateGitHubIssueInput {
  const normalizedStatus = createGitHubStatusFromTask(task.status);
  const normalizedPriority = createGitHubPriorityFromTask(task.priority);

  return {
    title: task.title,
    body: task.description,
    state: normalizedStatus.state,
    labels: mergeGitHubLabels(
      task.labels,
      normalizedStatus.statusLabel,
      normalizedPriority.priorityLabel
    ),
  };
}

export function createGitHubIssueUpdateFromTask(task: TaskWithDetail): UpdateGitHubIssueInput {
  return createGitHubIssueCreateFromTask(task);
}

export function normalizeGitHubIssueStatus(
  state: GitHubIssue["state"],
  labels: string[]
): NormalizedGitHubStatus {
  const statusLabels = labels.filter((label) => label.startsWith(STATUS_LABEL_PREFIX));

  if (state === "closed") {
    const closedStatusLabel = pickPreferredStatusLabel(statusLabels, CLOSED_STATUS_PRECEDENCE);
    const closedStatus = closedStatusLabel ? parseTaskStatusFromLabel(closedStatusLabel) : "done";

    return {
      state,
      status: closedStatus === "canceled" ? "canceled" : "done",
      statusLabel: createStatusLabel(closedStatus === "canceled" ? "canceled" : "done"),
    };
  }

  const openStatusLabel = pickPreferredStatusLabel(statusLabels, OPEN_STATUS_PRECEDENCE);
  const openStatus = openStatusLabel ? parseTaskStatusFromLabel(openStatusLabel) : "active";

  return {
    state,
    status:
      openStatus === "active" || openStatus === "inprogress" || openStatus === "waiting"
        ? openStatus
        : "active",
    statusLabel: createStatusLabel(
      openStatus === "active" || openStatus === "inprogress" || openStatus === "waiting"
        ? openStatus
        : "active"
    ),
  };
}

export function normalizeGitHubIssuePriority(labels: string[]): NormalizedGitHubPriority {
  const priorityLabels = labels.filter((label) => label.startsWith(PRIORITY_LABEL_PREFIX));
  const matchedPriorityLabel = PRIORITY_PRECEDENCE.map(createPriorityLabel).find((label) =>
    priorityLabels.includes(label)
  );
  const priority = matchedPriorityLabel
    ? parseTaskPriorityFromLabel(matchedPriorityLabel)
    : "medium";

  return {
    priority,
    priorityLabel: createPriorityLabel(priority),
  };
}

export function getNormalGitHubLabels(labels: string[]): string[] {
  return labels.filter(
    (label) => !label.startsWith(STATUS_LABEL_PREFIX) && !label.startsWith(PRIORITY_LABEL_PREFIX)
  );
}

export function mergeGitHubLabels(
  normalLabels: string[],
  statusLabel: string,
  priorityLabel: string
): string[] {
  const dedupedNormalLabels = [...new Set(getNormalGitHubLabels(normalLabels))];
  return [...dedupedNormalLabels, statusLabel, priorityLabel];
}

export function createGitHubStatusFromTask(status: TaskStatus): NormalizedGitHubStatus {
  if (status === "done" || status === "canceled") {
    return {
      state: "closed",
      status,
      statusLabel: createStatusLabel(status),
    };
  }

  return {
    state: "open",
    status,
    statusLabel: createStatusLabel(status),
  };
}

export function createGitHubPriorityFromTask(priority: Task["priority"]): NormalizedGitHubPriority {
  return {
    priority,
    priorityLabel: createPriorityLabel(priority),
  };
}

function createStatusLabel(status: TaskStatus): string {
  return `${STATUS_LABEL_PREFIX}${status}`;
}

function createPriorityLabel(priority: Task["priority"]): string {
  return `${PRIORITY_LABEL_PREFIX}${priority}`;
}

function pickPreferredStatusLabel(labels: string[], precedence: TaskStatus[]): string | null {
  for (const status of precedence) {
    const candidate = createStatusLabel(status);
    if (labels.includes(candidate)) {
      return candidate;
    }
  }

  return null;
}

function parseTaskStatusFromLabel(label: string): TaskStatus {
  return label.slice(STATUS_LABEL_PREFIX.length) as TaskStatus;
}

function parseTaskPriorityFromLabel(label: string): Task["priority"] {
  return label.slice(PRIORITY_LABEL_PREFIX.length) as Task["priority"];
}
