import {
  SYNC_PROVIDER_API_VERSION,
  type ExternalTask,
  type Project,
  type SyncProvider,
  type SyncProviderConfig,
  type SyncProviderPullResult,
  type SyncProviderRegistration,
  type Task,
} from "@todu/core";

import {
  bootstrapGitHubIssuesToTasks,
  bootstrapTasksToGitHubIssues,
  type GitHubBootstrapExportResult,
  type GitHubBootstrapImportResult,
} from "@/github-bootstrap";
import { createInMemoryGitHubIssueClient, type GitHubIssueClient } from "@/github-client";
import {
  GITHUB_PROVIDER_NAME,
  parseGitHubBinding,
  type GitHubRepositoryBinding,
} from "@/github-binding";
import { loadGitHubProviderSettings, type GitHubProviderSettings } from "@/github-config";
import { createImportedTaskId } from "@/github-ids";
import {
  createInMemoryGitHubItemLinkStore,
  type GitHubItemLink,
  type GitHubItemLinkStore,
} from "@/github-links";

export const GITHUB_PROVIDER_VERSION = "0.1.0";

const DEFAULT_TIMESTAMP = new Date(0).toISOString();
const OPEN_TASK_STATUSES = new Set(["active", "inprogress", "waiting"]);
const TASK_PRIORITIES = new Set(["low", "medium", "high"]);

export interface GitHubProviderState {
  initialized: boolean;
  settings: GitHubProviderSettings | null;
  itemLinks: GitHubItemLink[];
  lastPullResult: GitHubBootstrapImportResult | null;
  lastPushResult: GitHubBootstrapExportResult | null;
}

export interface GitHubSyncProvider extends SyncProvider {
  getState(): GitHubProviderState;
}

export interface CreateGitHubSyncProviderOptions {
  issueClient?: GitHubIssueClient;
  linkStore?: GitHubItemLinkStore;
}

export function createGitHubSyncProvider(
  options: CreateGitHubSyncProviderOptions = {}
): GitHubSyncProvider {
  let settings: GitHubProviderSettings | null = null;
  let lastPullResult: GitHubBootstrapImportResult | null = null;
  let lastPushResult: GitHubBootstrapExportResult | null = null;
  const issueClient = options.issueClient ?? createInMemoryGitHubIssueClient();
  const linkStore = options.linkStore ?? createInMemoryGitHubItemLinkStore();

  const requireInitializedSettings = (): GitHubProviderSettings => {
    if (!settings) {
      throw new Error(
        "GitHub sync provider is not initialized; call initialize() before sync operations"
      );
    }

    return settings;
  };

  const validateBinding = (
    binding: Parameters<SyncProvider["pull"]>[0]
  ): GitHubRepositoryBinding => {
    requireInitializedSettings();
    return parseGitHubBinding(binding);
  };

  return {
    name: GITHUB_PROVIDER_NAME,
    version: GITHUB_PROVIDER_VERSION,
    async initialize(config: SyncProviderConfig): Promise<void> {
      settings = loadGitHubProviderSettings(config);
    },
    async shutdown(): Promise<void> {
      settings = null;
      lastPullResult = null;
      lastPushResult = null;
    },
    async pull(binding, project): Promise<SyncProviderPullResult> {
      const parsedBinding = validateBinding(binding);
      if (binding.strategy === "none" || binding.strategy === "push") {
        lastPullResult = {
          tasks: [],
          createdLinks: [],
        };

        return {
          tasks: [],
        };
      }

      lastPullResult = await bootstrapGitHubIssuesToTasks({
        binding,
        owner: parsedBinding.owner,
        repo: parsedBinding.repo,
        project,
        issueClient,
        linkStore,
      });

      return {
        tasks: lastPullResult.tasks,
      };
    },
    async push(binding, tasks, _project): Promise<void> {
      const parsedBinding = validateBinding(binding);
      if (binding.strategy === "none" || binding.strategy === "pull") {
        lastPushResult = {
          createdIssues: [],
          createdLinks: [],
          taskUpdates: [],
        };
        return;
      }

      lastPushResult = await bootstrapTasksToGitHubIssues({
        binding,
        owner: parsedBinding.owner,
        repo: parsedBinding.repo,
        tasks,
        issueClient,
        linkStore,
      });
    },
    mapToTask(external: ExternalTask, project: Project): Task {
      return {
        id: createImportedTaskId(external.externalId),
        title: external.title,
        status: normalizeTaskStatus(external.status),
        priority: normalizeTaskPriority(external.priority),
        projectId: project.id,
        labels: [...(external.labels ?? [])],
        externalId: external.externalId,
        sourceUrl: external.sourceUrl,
        createdAt: external.createdAt ?? external.updatedAt ?? DEFAULT_TIMESTAMP,
        updatedAt: external.updatedAt ?? external.createdAt ?? DEFAULT_TIMESTAMP,
      };
    },
    mapFromTask(task: Task): ExternalTask {
      return {
        externalId: task.externalId ?? String(task.id),
        title: task.title,
        status: task.status,
        priority: task.priority,
        labels: [...task.labels],
        sourceUrl: task.sourceUrl,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
    },
    getState(): GitHubProviderState {
      return {
        initialized: settings !== null,
        settings,
        itemLinks: linkStore.listAll(),
        lastPullResult,
        lastPushResult,
      };
    },
  };
}

export const githubProvider = createGitHubSyncProvider();

export const syncProvider: SyncProviderRegistration = {
  manifest: {
    name: GITHUB_PROVIDER_NAME,
    version: GITHUB_PROVIDER_VERSION,
    apiVersion: SYNC_PROVIDER_API_VERSION,
  },
  provider: githubProvider,
};

function normalizeTaskStatus(status: string | undefined): Task["status"] {
  if (status && OPEN_TASK_STATUSES.has(status)) {
    return status as Task["status"];
  }

  if (status === "done" || status === "canceled") {
    return status;
  }

  return "active";
}

function normalizeTaskPriority(priority: string | undefined): Task["priority"] {
  if (priority && TASK_PRIORITIES.has(priority)) {
    return priority as Task["priority"];
  }

  return "medium";
}
