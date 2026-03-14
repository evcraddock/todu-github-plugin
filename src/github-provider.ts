import {
  SYNC_PROVIDER_API_VERSION,
  type ExternalTask,
  type IntegrationBinding,
  type Project,
  type SyncProvider,
  type SyncProviderConfig,
  type SyncProviderPullResult,
  type SyncProviderPushResult,
  type SyncProviderRegistration,
  type Task,
  type TaskPushPayload,
} from "@todu/core";

import {
  createBindingStatus,
  updateBindingStatusError,
  updateBindingStatusIdle,
  updateBindingStatusRunning,
  type BindingStatus,
} from "@/github-binding-status";
import {
  GITHUB_PROVIDER_NAME,
  parseGitHubBinding,
  type GitHubRepositoryBinding,
} from "@/github-binding";
import {
  bootstrapGitHubIssuesToTasks,
  bootstrapTasksToGitHubIssues,
  type GitHubBootstrapExportResult,
  type GitHubBootstrapImportResult,
} from "@/github-bootstrap";
import { createInMemoryGitHubIssueClient, type GitHubIssueClient } from "@/github-client";
import { createHttpGitHubIssueClient } from "@/github-http-client";
import {
  createInMemoryGitHubCommentLinkStore,
  type GitHubCommentLink,
  type GitHubCommentLinkStore,
} from "@/github-comment-links";
import { pullComments, pushComments } from "@/github-comments";
import { loadGitHubProviderSettings, type GitHubProviderSettings } from "@/github-config";
import { createImportedTaskId } from "@/github-ids";
import {
  createFileGitHubItemLinkStore,
  createInMemoryGitHubItemLinkStore,
  type GitHubItemLink,
  type GitHubItemLinkStore,
} from "@/github-links";
import {
  createGitHubSyncLogger,
  type GitHubSyncLogger,
  type SyncLogContext,
} from "@/github-logger";
import {
  createLoopPreventionStore,
  createWriteKey,
  type LoopPreventionStore,
} from "@/github-loop-prevention";
import {
  createInMemoryBindingRuntimeStore,
  createInitialRuntimeState,
  recordFailure,
  recordSuccess,
  shouldRetry,
  type BindingRuntimeStore,
  type RetryConfig,
} from "@/github-runtime";

export const GITHUB_PROVIDER_VERSION = "0.1.0";

const DEFAULT_TIMESTAMP = new Date(0).toISOString();
const OPEN_TASK_STATUSES = new Set(["active", "inprogress", "waiting"]);
const TASK_PRIORITIES = new Set(["low", "medium", "high"]);
const DEFAULT_LOOP_PREVENTION_MAX_AGE_MS = 10 * 60 * 1000;
const IMPORT_CLOSED_ON_BOOTSTRAP_OPTION = "importClosedOnBootstrap";

export interface GitHubProviderState {
  initialized: boolean;
  settings: GitHubProviderSettings | null;
  itemLinks: GitHubItemLink[];
  commentLinks: GitHubCommentLink[];
  lastPullResult: GitHubBootstrapImportResult | null;
  lastPushResult: GitHubBootstrapExportResult | null;
  bindingStatuses: Map<IntegrationBinding["id"], BindingStatus>;
}

export interface GitHubSyncProvider extends SyncProvider {
  getState(): GitHubProviderState;
}

export interface CreateGitHubSyncProviderOptions {
  issueClient?: GitHubIssueClient;
  linkStore?: GitHubItemLinkStore;
  commentLinkStore?: GitHubCommentLinkStore;
  runtimeStore?: BindingRuntimeStore;
  loopPreventionStore?: LoopPreventionStore;
  logger?: GitHubSyncLogger;
  retryConfig?: RetryConfig;
}

function isImportClosedOnBootstrapEnabled(binding: IntegrationBinding): boolean {
  return binding.options?.[IMPORT_CLOSED_ON_BOOTSTRAP_OPTION] === true;
}

export function createGitHubSyncProvider(
  options: CreateGitHubSyncProviderOptions = {}
): GitHubSyncProvider {
  let settings: GitHubProviderSettings | null = null;
  let lastPullResult: GitHubBootstrapImportResult | null = null;
  let lastPushResult: GitHubBootstrapExportResult | null = null;
  let issueClient: GitHubIssueClient = options.issueClient ?? createInMemoryGitHubIssueClient();
  let linkStore = options.linkStore ?? createInMemoryGitHubItemLinkStore();
  const commentLinkStore = options.commentLinkStore ?? createInMemoryGitHubCommentLinkStore();
  const runtimeStore = options.runtimeStore ?? createInMemoryBindingRuntimeStore();
  const loopPreventionStore = options.loopPreventionStore ?? createLoopPreventionStore();
  const logger = options.logger ?? createGitHubSyncLogger();
  const retryConfig = options.retryConfig;
  const bindingStatuses = new Map<IntegrationBinding["id"], BindingStatus>();

  const getOrCreateBindingStatus = (bindingId: IntegrationBinding["id"]): BindingStatus => {
    let status = bindingStatuses.get(bindingId);
    if (!status) {
      status = createBindingStatus(bindingId);
      bindingStatuses.set(bindingId, status);
    }

    return status;
  };

  const getOrCreateRuntimeState = (bindingId: IntegrationBinding["id"]) => {
    let state = runtimeStore.get(bindingId);
    if (!state) {
      state = createInitialRuntimeState(bindingId);
      runtimeStore.save(state);
    }

    return state;
  };

  const createLogContext = (
    binding: IntegrationBinding,
    parsedBinding: GitHubRepositoryBinding,
    direction: "pull" | "push"
  ): SyncLogContext => ({
    bindingId: binding.id,
    projectId: String(binding.projectId),
    repo: `${parsedBinding.owner}/${parsedBinding.repo}`,
    direction,
  });

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
      if (!options.issueClient) {
        issueClient = createHttpGitHubIssueClient(settings.token);
      }

      if (!options.linkStore) {
        linkStore = createFileGitHubItemLinkStore(settings.storagePath);
      }
    },
    async shutdown(): Promise<void> {
      settings = null;
      lastPullResult = null;
      lastPushResult = null;
    },
    async pull(binding, _project): Promise<SyncProviderPullResult> {
      const parsedBinding = validateBinding(binding);
      const logContext = createLogContext(binding, parsedBinding, "pull");

      if (binding.strategy === "none" || binding.strategy === "push") {
        lastPullResult = { tasks: [], createdLinks: [] };
        logger.debug("skipping pull due to binding strategy", logContext);
        return { tasks: [] };
      }

      const runtimeState = getOrCreateRuntimeState(binding.id);
      if (!shouldRetry(runtimeState)) {
        logger.info("skipping pull: retry backoff not elapsed", logContext);
        return { tasks: [] };
      }

      const status = getOrCreateBindingStatus(binding.id);
      bindingStatuses.set(binding.id, updateBindingStatusRunning(status));
      logger.info("pull started", logContext);

      try {
        loopPreventionStore.clearExpired(DEFAULT_LOOP_PREVENTION_MAX_AGE_MS);

        lastPullResult = await bootstrapGitHubIssuesToTasks({
          binding,
          owner: parsedBinding.owner,
          repo: parsedBinding.repo,
          issueClient,
          linkStore,
          since: runtimeState.lastSuccessAt ?? undefined,
          importClosedOnBootstrap:
            runtimeState.lastSuccessAt == null && isImportClosedOnBootstrapEnabled(binding),
        });

        const pullCommentsResult = await pullComments({
          binding,
          owner: parsedBinding.owner,
          repo: parsedBinding.repo,
          issueClient,
          itemLinkStore: linkStore,
          commentLinkStore,
        });

        const updatedRuntimeState = recordSuccess(runtimeState, null);
        runtimeStore.save(updatedRuntimeState);
        bindingStatuses.set(
          binding.id,
          updateBindingStatusIdle(getOrCreateBindingStatus(binding.id))
        );

        logger.info("pull completed", {
          ...logContext,
          itemId: `${lastPullResult.tasks.length} tasks, ${pullCommentsResult.comments.length} comments`,
        });

        return {
          tasks: lastPullResult.tasks,
          comments: pullCommentsResult.comments,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const failedState = recordFailure(runtimeState, errorMessage, retryConfig);
        runtimeStore.save(failedState);
        bindingStatuses.set(
          binding.id,
          updateBindingStatusError(getOrCreateBindingStatus(binding.id), errorMessage)
        );

        logger.error("pull failed", logContext, errorMessage);
        throw error;
      }
    },
    async push(binding, tasks: TaskPushPayload[], _project): Promise<SyncProviderPushResult> {
      const parsedBinding = validateBinding(binding);
      const logContext = createLogContext(binding, parsedBinding, "push");

      if (binding.strategy === "none" || binding.strategy === "pull") {
        lastPushResult = {
          createdIssues: [],
          updatedIssues: [],
          createdLinks: [],
          taskUpdates: [],
        };
        logger.debug("skipping push due to binding strategy", logContext);
        return { commentLinks: [], taskLinks: [] };
      }

      const runtimeState = getOrCreateRuntimeState(binding.id);
      if (!shouldRetry(runtimeState)) {
        logger.info("skipping push: retry backoff not elapsed", logContext);
        return { commentLinks: [], taskLinks: [] };
      }

      const status = getOrCreateBindingStatus(binding.id);
      bindingStatuses.set(binding.id, updateBindingStatusRunning(status));
      logger.info("push started", logContext);

      try {
        lastPushResult = await bootstrapTasksToGitHubIssues({
          binding,
          owner: parsedBinding.owner,
          repo: parsedBinding.repo,
          tasks,
          issueClient,
          linkStore,
        });

        for (const createdIssue of lastPushResult.createdIssues) {
          const writeKey = createWriteKey("issue", String(binding.id), String(createdIssue.number));
          loopPreventionStore.recordWrite(
            writeKey,
            createdIssue.updatedAt ?? new Date().toISOString()
          );
        }

        for (const updatedIssue of lastPushResult.updatedIssues) {
          const writeKey = createWriteKey("issue", String(binding.id), String(updatedIssue.number));
          loopPreventionStore.recordWrite(
            writeKey,
            updatedIssue.updatedAt ?? new Date().toISOString()
          );
        }

        const pushCommentsResult = await pushComments({
          binding,
          owner: parsedBinding.owner,
          repo: parsedBinding.repo,
          tasks,
          issueClient,
          itemLinkStore: linkStore,
          commentLinkStore,
        });

        for (const createdComment of pushCommentsResult.createdComments) {
          const writeKey = createWriteKey("comment", String(binding.id), String(createdComment.id));
          loopPreventionStore.recordWrite(
            writeKey,
            createdComment.updatedAt ?? createdComment.createdAt
          );
        }

        for (const updatedComment of pushCommentsResult.updatedComments) {
          const writeKey = createWriteKey("comment", String(binding.id), String(updatedComment.id));
          loopPreventionStore.recordWrite(
            writeKey,
            updatedComment.updatedAt ?? updatedComment.createdAt
          );
        }

        const updatedRuntimeState = recordSuccess(runtimeState, null);
        runtimeStore.save(updatedRuntimeState);
        bindingStatuses.set(
          binding.id,
          updateBindingStatusIdle(getOrCreateBindingStatus(binding.id))
        );

        logger.info("push completed", {
          ...logContext,
          itemId: `${lastPushResult.createdIssues.length} created, ${lastPushResult.updatedIssues.length} updated`,
        });

        const taskLinks = lastPushResult.createdLinks.map((link) => ({
          localTaskId: link.taskId,
          externalId: link.externalId,
          sourceUrl: `https://github.com/${parsedBinding.owner}/${parsedBinding.repo}/issues/${link.issueNumber}`,
        }));

        return { commentLinks: pushCommentsResult.commentLinks, taskLinks };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const failedState = recordFailure(runtimeState, errorMessage, retryConfig);
        runtimeStore.save(failedState);
        bindingStatuses.set(
          binding.id,
          updateBindingStatusError(getOrCreateBindingStatus(binding.id), errorMessage)
        );

        logger.error("push failed", logContext, errorMessage);
        throw error;
      }
    },
    mapToTask(external: ExternalTask, project: Project): Task {
      return {
        id: createImportedTaskId(external.externalId),
        title: external.title,
        status: normalizeTaskStatus(external.status),
        priority: normalizeTaskPriority(external.priority),
        projectId: project.id,
        labels: [...(external.labels ?? [])],
        assignees: [...(external.assignees ?? [])],
        externalId: external.externalId,
        sourceUrl: external.sourceUrl,
        createdAt: external.createdAt ?? external.updatedAt ?? DEFAULT_TIMESTAMP,
        updatedAt: external.updatedAt ?? external.createdAt ?? DEFAULT_TIMESTAMP,
      };
    },
    mapFromTask(task: TaskPushPayload, _project: Project): ExternalTask {
      return {
        externalId: task.externalId ?? String(task.id),
        title: task.title,
        description: task.description,
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
        commentLinks: commentLinkStore.listAll(),
        lastPullResult,
        lastPushResult,
        bindingStatuses,
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
