import type {
  ExportedTaskInput,
  ExternalActorRef,
  ImportedTaskInput,
  Task,
  TaskStatus,
} from "@todu/core";

import type {
  CreateGitHubIssueInput,
  GitHubIssue,
  GitHubUserRef,
  UpdateGitHubIssueInput,
} from "@/github-client";

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
  assignees: ExternalActorRef[];
}

export function createGitHubAssigneesFromTask(task: ExportedTaskInput): string[] {
  return task.assignees.flatMap((assignee) => {
    if (assignee.externalLogin && assignee.externalLogin.trim().length > 0) {
      return [assignee.externalLogin];
    }

    if (assignee.displayName && /^[A-Za-z0-9-]+$/.test(assignee.displayName)) {
      return [assignee.displayName];
    }

    return [];
  });
}

export function mapGitHubUserToExternalActorRef(user: GitHubUserRef): ExternalActorRef {
  return {
    ...(user.id !== undefined ? { externalAccountId: user.id } : {}),
    ...(user.login !== undefined ? { externalLogin: user.login } : {}),
    ...(user.displayName !== undefined ? { displayName: user.displayName } : {}),
    ...(user.raw !== undefined ? { raw: user.raw } : {}),
  };
}

export function mapGitHubIssueToImportedTask(issue: GitHubIssue): ImportedTaskInput {
  const normalizedStatus = normalizeGitHubIssueStatus(issue.state, issue.labels);
  const normalizedPriority = normalizeGitHubIssuePriority(issue.labels);

  return {
    externalId: issue.externalId,
    title: issue.title,
    description: issue.body,
    status: normalizedStatus.status,
    priority: normalizedPriority.priority,
    labels: getNormalGitHubLabels(issue.labels),
    assignees: issue.assignees.map(mapGitHubUserToExternalActorRef),
    sourceUrl: issue.sourceUrl,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    raw: issue,
  };
}

export function createGitHubIssueCreateFromTask(task: ExportedTaskInput): CreateGitHubIssueInput {
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
    assignees: createGitHubAssigneesFromTask(task),
  };
}

export function createGitHubIssueUpdateFromTask(task: ExportedTaskInput): UpdateGitHubIssueInput {
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
