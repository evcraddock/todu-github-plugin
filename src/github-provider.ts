import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type {
  ExportedTaskInput,
  IntegrationBinding,
  Project,
  SyncProviderConfig,
  SyncProviderPullResultV3,
  SyncProviderPushResult,
  SyncProviderRegistration,
  SyncProviderV3,
} from "@todu/core";
import { SYNC_PROVIDER_API_VERSION } from "@todu/core";

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
import { pullComments, pushComments } from "@/github-comments";
import {
  createFileGitHubCommentLinkStore,
  createInMemoryGitHubCommentLinkStore,
  type GitHubCommentLink,
  type GitHubCommentLinkStore,
} from "@/github-comment-links";
import { loadGitHubProviderSettings, type GitHubProviderSettings } from "@/github-config";
import { createHttpGitHubIssueClient, isGitHubRateLimitError } from "@/github-http-client";
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
  createFileBindingRuntimeStore,
  createInMemoryBindingRuntimeStore,
  createInitialRuntimeState,
  recordFailure,
  recordSuccess,
  shouldRetry,
  type BindingRuntimeStore,
  type RetryConfig,
} from "@/github-runtime";

export const GITHUB_PROVIDER_VERSION = "0.1.0";

const DEFAULT_LOOP_PREVENTION_MAX_AGE_MS = 10 * 60 * 1000;
const IMPORT_CLOSED_ON_BOOTSTRAP_OPTION = "importClosedOnBootstrap";
const RATE_LIMIT_FALLBACK_DELAY_SECONDS = 15 * 60;
const SECONDARY_RATE_LIMIT_FALLBACK_DELAY_SECONDS = 60 * 60;
const COMMENT_LINK_STORAGE_FILE = "comment-links.json";
const RUNTIME_STORAGE_FILE = "runtime-state.json";

export interface GitHubProviderState {
  initialized: boolean;
  settings: GitHubProviderSettings | null;
  itemLinks: GitHubItemLink[];
  commentLinks: GitHubCommentLink[];
  lastPullResult: GitHubBootstrapImportResult | null;
  lastPushResult: GitHubBootstrapExportResult | null;
  bindingStatuses: Map<IntegrationBinding["id"], BindingStatus>;
}

export interface GitHubSyncProvider extends SyncProviderV3 {
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
  loadTaskNotes?: (
    taskId: ExportedTaskInput["localTaskId"]
  ) => Promise<Array<{ id: string; tags: string[] }>>;
}

function isImportClosedOnBootstrapEnabled(binding: IntegrationBinding): boolean {
  return binding.options?.[IMPORT_CLOSED_ON_BOOTSTRAP_OPTION] === true;
}

function getRetryOverrideForError(
  error: unknown
): { delaySeconds?: number; retryAt?: Date } | undefined {
  if (!isGitHubRateLimitError(error)) {
    return undefined;
  }

  if (error.retryAt != null) {
    const retryAt = new Date(error.retryAt);
    if (!Number.isNaN(retryAt.getTime())) {
      return { retryAt };
    }
  }

  if (error.isSecondaryRateLimitError) {
    return { delaySeconds: SECONDARY_RATE_LIMIT_FALLBACK_DELAY_SECONDS };
  }

  return { delaySeconds: RATE_LIMIT_FALLBACK_DELAY_SECONDS };
}

function getErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (isGitHubRateLimitError(error) && error.retryAt != null) {
    return `${message} (retry after ${error.retryAt})`;
  }

  if (isGitHubRateLimitError(error) && error.isSecondaryRateLimitError) {
    return `${message} (retry delayed due to GitHub secondary rate limit)`;
  }

  if (isGitHubRateLimitError(error)) {
    return `${message} (retry delayed due to GitHub rate limit)`;
  }

  return message;
}

function createSiblingStoragePath(storagePath: string, fileName: string): string {
  return path.join(path.dirname(storagePath), fileName);
}

const execFileAsync = promisify(execFile);

async function loadTaskNotesFromCli(
  taskId: ExportedTaskInput["localTaskId"]
): Promise<Array<{ id: ExportedTaskInput["comments"][number]["localNoteId"]; tags: string[] }>> {
  const { stdout } = await execFileAsync("todu", ["--format", "json", "note", "list", "--task", String(taskId)]);
  const parsed = JSON.parse(stdout) as Array<{ id: string; tags?: unknown }>;
  return parsed.map((note) => ({
    id: note.id as ExportedTaskInput["comments"][number]["localNoteId"],
    tags: Array.isArray(note.tags) ? note.tags.filter((tag): tag is string => typeof tag === "string") : [],
  }));
}

export function createGitHubSyncProvider(
  options: CreateGitHubSyncProviderOptions = {}
): GitHubSyncProvider {
  let settings: GitHubProviderSettings | null = null;
  let lastPullResult: GitHubBootstrapImportResult | null = null;
  let lastPushResult: GitHubBootstrapExportResult | null = null;
  let issueClient: GitHubIssueClient = options.issueClient ?? createInMemoryGitHubIssueClient();
  let linkStore = options.linkStore ?? createInMemoryGitHubItemLinkStore();
  let commentLinkStore = options.commentLinkStore ?? createInMemoryGitHubCommentLinkStore();
  let runtimeStore = options.runtimeStore ?? createInMemoryBindingRuntimeStore();
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

  const validateBinding = (binding: IntegrationBinding): GitHubRepositoryBinding => {
    requireInitializedSettings();
    return parseGitHubBinding(binding);
  };

  return {
    name: GITHUB_PROVIDER_NAME,
    version: GITHUB_PROVIDER_VERSION,
    async initialize(config: SyncProviderConfig): Promise<void> {
      settings = loadGitHubProviderSettings(config);
      const commentLinkStoragePath = createSiblingStoragePath(
        settings.storagePath,
        COMMENT_LINK_STORAGE_FILE
      );
      const runtimeStoragePath = createSiblingStoragePath(
        settings.storagePath,
        RUNTIME_STORAGE_FILE
      );

      if (!options.issueClient) {
        issueClient = createHttpGitHubIssueClient(settings.token);
      }

      if (!options.linkStore) {
        linkStore = createFileGitHubItemLinkStore(settings.storagePath);
      }

      if (!options.commentLinkStore) {
        commentLinkStore = createFileGitHubCommentLinkStore(commentLinkStoragePath);
      }

      if (!options.runtimeStore) {
        runtimeStore = createFileBindingRuntimeStore(runtimeStoragePath);
      }
    },
    async shutdown(): Promise<void> {
      settings = null;
      lastPullResult = null;
      lastPushResult = null;
    },
    async pull(binding, _project): Promise<SyncProviderPullResultV3> {
      const parsedBinding = validateBinding(binding);
      const logContext = createLogContext(binding, parsedBinding, "pull");

      if (binding.strategy === "none" || binding.strategy === "push") {
        lastPullResult = { tasks: [], createdLinks: [], touchedIssueNumbers: [] };
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
          issueNumbers: lastPullResult.touchedIssueNumbers,
          since: runtimeState.lastSuccessAt ?? undefined,
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
        const errorSummary = getErrorSummary(error);
        const failedState = recordFailure(
          runtimeState,
          errorSummary,
          retryConfig,
          new Date(),
          getRetryOverrideForError(error)
        );
        runtimeStore.save(failedState);
        bindingStatuses.set(
          binding.id,
          updateBindingStatusError(getOrCreateBindingStatus(binding.id), errorSummary)
        );

        logger.error("pull failed", logContext, errorSummary);
        throw error;
      }
    },
    async push(binding, tasks: ExportedTaskInput[], _project: Project): Promise<SyncProviderPushResult> {
      const parsedBinding = validateBinding(binding);
      const logContext = createLogContext(binding, parsedBinding, "push");

      if (binding.strategy === "none" || binding.strategy === "pull") {
        lastPushResult = {
          createdIssues: [],
          updatedIssues: [],
          createdLinks: [],
          taskUpdates: [],
          hydratedLinkedTasks: 0,
          issueReadCount: 0,
          skippedLinkedTasks: 0,
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
          loadTaskNotes: options.loadTaskNotes,
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
          itemId:
            `${lastPushResult.createdIssues.length} created, ` +
            `${lastPushResult.updatedIssues.length} updated, ` +
            `${lastPushResult.skippedLinkedTasks} skipped, ` +
            `${lastPushResult.issueReadCount} issue reads, ` +
            `${pushCommentsResult.createdComments.length} comment creates, ` +
            `${pushCommentsResult.updatedComments.length} comment updates`,
        });

        const taskLinks = lastPushResult.createdLinks.map((link) => ({
          localTaskId: link.taskId,
          externalId: link.externalId,
          sourceUrl: `https://github.com/${parsedBinding.owner}/${parsedBinding.repo}/issues/${link.issueNumber}`,
        }));

        return { commentLinks: pushCommentsResult.commentLinks, taskLinks };
      } catch (error) {
        const errorSummary = getErrorSummary(error);
        const failedState = recordFailure(
          runtimeState,
          errorSummary,
          retryConfig,
          new Date(),
          getRetryOverrideForError(error)
        );
        runtimeStore.save(failedState);
        bindingStatuses.set(
          binding.id,
          updateBindingStatusError(getOrCreateBindingStatus(binding.id), errorSummary)
        );

        logger.error("push failed", logContext, errorSummary);
        throw error;
      }
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

export const githubProvider = createGitHubSyncProvider({ loadTaskNotes: loadTaskNotesFromCli });

export const syncProvider: SyncProviderRegistration = {
  manifest: {
    name: GITHUB_PROVIDER_NAME,
    version: GITHUB_PROVIDER_VERSION,
    apiVersion: SYNC_PROVIDER_API_VERSION,
  },
  provider: githubProvider,
};
