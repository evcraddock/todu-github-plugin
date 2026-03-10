import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createIntegrationBindingId,
  createProjectId,
  createTaskId,
  type IntegrationBinding,
  type Project,
  type Task,
} from "@todu/core";
import { describe, expect, it } from "vitest";

import {
  GITHUB_PROVIDER_NAME,
  GITHUB_REPOSITORY_TARGET_KIND,
  GitHubBindingValidationError,
  GitHubExternalIdError,
  GitHubProviderConfigError,
  createGitHubSyncProvider,
  createInMemoryGitHubIssueClient,
  createInMemoryGitHubItemLinkStore,
  formatIssueExternalId,
  loadGitHubProviderSettings,
  parseGitHubBinding,
  parseGitHubRepositoryTargetRef,
  parseIssueExternalId,
} from "@/index";

describe("parseGitHubRepositoryTargetRef", () => {
  it("parses owner/repo target refs", () => {
    expect(parseGitHubRepositoryTargetRef("evcraddock/todu")).toEqual({
      owner: "evcraddock",
      repo: "todu",
    });
  });

  it("rejects malformed target refs with context", () => {
    expect(() => parseGitHubRepositoryTargetRef("evcraddock")).toThrowError(
      /expected owner\/repo format/
    );

    try {
      parseGitHubRepositoryTargetRef("evcraddock");
      throw new Error("Expected target ref parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubBindingValidationError);
      expect((error as GitHubBindingValidationError).code).toBe("INVALID_TARGET_REF");
    }
  });
});

describe("parseIssueExternalId", () => {
  it("parses owner/repo#number external IDs", () => {
    expect(parseIssueExternalId("evcraddock/todu-github-plugin#42")).toEqual({
      owner: "evcraddock",
      repo: "todu-github-plugin",
      issueNumber: 42,
    });
  });

  it("rejects malformed external IDs", () => {
    expect(() => parseIssueExternalId("evcraddock/todu-github-plugin")).toThrowError(
      /expected owner\/repo#number format/
    );
    expect(() => parseIssueExternalId("evcraddock/todu-github-plugin#0")).toThrowError(
      /issue number must be a positive integer/
    );

    try {
      parseIssueExternalId("bad-value");
      throw new Error("Expected external ID parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubExternalIdError);
    }
  });
});

describe("parseGitHubBinding", () => {
  it("accepts github repository bindings", () => {
    const binding = createBinding();

    expect(parseGitHubBinding(binding)).toMatchObject({
      binding,
      owner: "evcraddock",
      repo: "todu-github-plugin",
    });
  });

  it("rejects non-github providers", () => {
    expect(() => parseGitHubBinding(createBinding({ provider: "forgejo" }))).toThrowError(
      /provider must be `github`/
    );
  });

  it("rejects unsupported target kinds", () => {
    expect(() => parseGitHubBinding(createBinding({ targetKind: "organization" }))).toThrowError(
      /targetKind must be `repository`/
    );
  });
});

describe("loadGitHubProviderSettings", () => {
  it("loads a trimmed token from provider settings", () => {
    expect(loadGitHubProviderSettings({ settings: { token: "  secret-token  " } })).toEqual({
      token: "secret-token",
      storagePath: ".todu-github-plugin/item-links.json",
    });
  });

  it("fails clearly when token is missing", () => {
    expect(() => loadGitHubProviderSettings({ settings: {} })).toThrowError(
      /missing non-empty settings.token/
    );

    try {
      loadGitHubProviderSettings({ settings: {} });
      throw new Error("Expected provider settings validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubProviderConfigError);
      expect((error as GitHubProviderConfigError).code).toBe("MISSING_TOKEN");
    }
  });
});

describe("createGitHubSyncProvider", () => {
  it("initializes, validates bindings, bootstraps open GitHub issues, and shuts down cleanly", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues({ owner: "evcraddock", repo: "todu-github-plugin" }, [
      {
        number: 1,
        title: "Open issue",
        body: "Imported from GitHub",
        state: "open",
        labels: ["bug"],
        sourceUrl: "https://github.com/evcraddock/todu-github-plugin/issues/1",
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: "2026-03-10T00:00:00.000Z",
      },
      {
        number: 2,
        title: "Pull request",
        body: "Should be ignored",
        state: "open",
        labels: [],
        isPullRequest: true,
      },
      {
        number: 3,
        title: "Closed issue",
        body: "Should be ignored",
        state: "closed",
        labels: [],
      },
    ]);

    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });
    const project = createProject();
    const binding = createBinding();

    await expect(provider.pull(binding, project)).rejects.toThrowError(/not initialized/);

    await provider.initialize({ settings: { token: "secret-token" } });

    const pullResult = await provider.pull(binding, project);
    expect(pullResult.tasks).toEqual([
      {
        externalId: "evcraddock/todu-github-plugin#1",
        title: "Open issue",
        description: "Imported from GitHub",
        labels: ["bug"],
        sourceUrl: "https://github.com/evcraddock/todu-github-plugin/issues/1",
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: "2026-03-10T00:00:00.000Z",
        raw: {
          number: 1,
          title: "Open issue",
          body: "Imported from GitHub",
          state: "open",
          labels: ["bug"],
          sourceUrl: "https://github.com/evcraddock/todu-github-plugin/issues/1",
          createdAt: "2026-03-10T00:00:00.000Z",
          updatedAt: "2026-03-10T00:00:00.000Z",
        },
      },
    ]);
    expect(provider.getState()).toMatchObject({
      initialized: true,
      settings: { token: "secret-token" },
      itemLinks: [
        {
          bindingId: binding.id,
          taskId: createTaskId("github:evcraddock/todu-github-plugin#1"),
          issueNumber: 1,
          externalId: "evcraddock/todu-github-plugin#1",
        },
      ],
    });

    await expect(provider.shutdown()).resolves.toBeUndefined();
    expect(provider.getState()).toEqual({
      initialized: false,
      settings: null,
      itemLinks: [
        {
          bindingId: binding.id,
          taskId: createTaskId("github:evcraddock/todu-github-plugin#1"),
          issueNumber: 1,
          externalId: "evcraddock/todu-github-plugin#1",
        },
      ],
      lastPullResult: null,
      lastPushResult: null,
    });
  });

  it("bootstraps active/inprogress/waiting tasks into GitHub and ignores done/canceled", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });
    const binding = createBinding();
    const project = createProject();

    await provider.initialize({ settings: { token: "secret-token" } });
    const activeTask = createTask({ id: "task-1", title: "Active task", status: "active" });
    const inProgressTask = createTask({
      id: "task-2",
      title: "In progress task",
      status: "inprogress",
    });
    const waitingTask = createTask({ id: "task-3", title: "Waiting task", status: "waiting" });
    const doneTask = createTask({ id: "task-4", title: "Done task", status: "done" });
    const canceledTask = createTask({ id: "task-5", title: "Canceled task", status: "canceled" });

    await provider.push(
      binding,
      [activeTask, inProgressTask, waitingTask, doneTask, canceledTask],
      project
    );

    expect(
      issueClient.snapshotIssues({ owner: "evcraddock", repo: "todu-github-plugin" })
    ).toMatchObject([
      { number: 1, title: "Active task", state: "open" },
      { number: 2, title: "In progress task", state: "open" },
      { number: 3, title: "Waiting task", state: "open" },
    ]);
    expect(provider.getState().lastPushResult).toMatchObject({
      createdIssues: [{ number: 1 }, { number: 2 }, { number: 3 }],
      taskUpdates: [
        {
          taskId: createTaskId("task-1"),
          externalId: "evcraddock/todu-github-plugin#1",
        },
        {
          taskId: createTaskId("task-2"),
          externalId: "evcraddock/todu-github-plugin#2",
        },
        {
          taskId: createTaskId("task-3"),
          externalId: "evcraddock/todu-github-plugin#3",
        },
      ],
    });
    expect(activeTask.externalId).toBe("evcraddock/todu-github-plugin#1");
    expect(inProgressTask.externalId).toBe("evcraddock/todu-github-plugin#2");
    expect(waitingTask.externalId).toBe("evcraddock/todu-github-plugin#3");
    expect(doneTask.externalId).toBeUndefined();
    expect(canceledTask.externalId).toBeUndefined();
  });

  it("honors an existing matching external_id and does not create a duplicate issue", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });
    const binding = createBinding();
    const project = createProject();
    const existingExternalId = formatIssueExternalId({
      owner: "evcraddock",
      repo: "todu-github-plugin",
      issueNumber: 99,
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    const linkedTask = createTask({
      id: "task-99",
      title: "Already linked",
      status: "active",
      externalId: existingExternalId,
    });

    await provider.push(binding, [linkedTask], project);

    expect(issueClient.snapshotIssues({ owner: "evcraddock", repo: "todu-github-plugin" })).toEqual(
      []
    );
    expect(provider.getState().lastPushResult).toEqual({
      createdIssues: [],
      createdLinks: [
        {
          bindingId: binding.id,
          taskId: createTaskId("task-99"),
          issueNumber: 99,
          externalId: existingExternalId,
        },
      ],
      taskUpdates: [],
    });
    expect(linkedTask.externalId).toBe(existingExternalId);
    expect(linkedTask.sourceUrl).toBe("https://github.com/evcraddock/todu-github-plugin/issues/99");
  });

  it("follows the duplicate policy by creating a new issue instead of fuzzy matching by title", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues({ owner: "evcraddock", repo: "todu-github-plugin" }, [
      {
        number: 1,
        title: "Duplicate title",
        body: "Existing issue",
        state: "open",
        labels: [],
      },
    ]);
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });
    const duplicateTask = createTask({
      id: "task-dup",
      title: "Duplicate title",
      status: "active",
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    await provider.push(createBinding(), [duplicateTask], createProject());

    expect(
      issueClient.snapshotIssues({ owner: "evcraddock", repo: "todu-github-plugin" })
    ).toMatchObject([
      { number: 1, title: "Duplicate title" },
      { number: 2, title: "Duplicate title" },
    ]);
    expect(provider.getState().lastPushResult?.taskUpdates).toEqual([
      {
        taskId: createTaskId("task-dup"),
        externalId: "evcraddock/todu-github-plugin#2",
        sourceUrl: "https://github.com/evcraddock/todu-github-plugin/issues/2",
      },
    ]);
    expect(duplicateTask.externalId).toBe("evcraddock/todu-github-plugin#2");
  });

  it("persists item links in file-backed local runtime storage across provider instances", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "todu-github-plugin-"));
    const storagePath = path.join(tempDirectory, "item-links.json");
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues({ owner: "evcraddock", repo: "todu-github-plugin" }, [
      {
        number: 1,
        title: "Persisted issue",
        body: "Body",
        state: "open",
        labels: [],
      },
    ]);

    const firstProvider = createGitHubSyncProvider({ issueClient });
    await firstProvider.initialize({ settings: { token: "secret-token", storagePath } });
    await firstProvider.pull(createBinding(), createProject());

    expect(fs.existsSync(storagePath)).toBe(true);

    const secondProvider = createGitHubSyncProvider({ issueClient });
    await secondProvider.initialize({ settings: { token: "secret-token", storagePath } });

    await expect(secondProvider.pull(createBinding(), createProject())).resolves.toEqual({
      tasks: [],
    });
    expect(secondProvider.getState().itemLinks).toEqual([
      {
        bindingId: createIntegrationBindingId("binding-1"),
        taskId: createTaskId("github:evcraddock/todu-github-plugin#1"),
        issueNumber: 1,
        externalId: "evcraddock/todu-github-plugin#1",
      },
    ]);
  });

  it("respects binding strategy for bootstrap pull and push", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues({ owner: "evcraddock", repo: "todu-github-plugin" }, [
      {
        number: 1,
        title: "Strategy issue",
        body: "Body",
        state: "open",
        labels: [],
      },
    ]);
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });

    await expect(
      provider.pull(createBinding({ strategy: "push" }), createProject())
    ).resolves.toEqual({
      tasks: [],
    });
    await expect(
      provider.push(
        createBinding({ strategy: "pull" }),
        [createTask({ id: "task-strategy", title: "Should not export", status: "active" })],
        createProject()
      )
    ).resolves.toBeUndefined();

    expect(
      issueClient.snapshotIssues({ owner: "evcraddock", repo: "todu-github-plugin" })
    ).toHaveLength(1);
    expect(provider.getState().lastPushResult).toEqual({
      createdIssues: [],
      createdLinks: [],
      taskUpdates: [],
    });
  });
});

function createBinding(overrides: Partial<IntegrationBinding> = {}): IntegrationBinding {
  return {
    id: createIntegrationBindingId("binding-1"),
    provider: overrides.provider ?? GITHUB_PROVIDER_NAME,
    projectId: overrides.projectId ?? createProjectId("project-1"),
    targetKind: overrides.targetKind ?? GITHUB_REPOSITORY_TARGET_KIND,
    targetRef: overrides.targetRef ?? "evcraddock/todu-github-plugin",
    strategy: overrides.strategy ?? "bidirectional",
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? "2026-03-09T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-09T00:00:00.000Z",
  };
}

function createProject(): Project {
  return {
    id: createProjectId("project-1"),
    name: "todu-github-plugin",
    status: "active",
    priority: "high",
    createdAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z",
  };
}

function createTask(
  overrides: {
    id: string;
    title: string;
    status: Task["status"];
  } & Partial<Omit<Task, "id" | "title" | "status">>
): Task {
  return {
    id: createTaskId(overrides.id),
    title: overrides.title,
    status: overrides.status,
    priority: overrides.priority ?? "medium",
    projectId: overrides.projectId ?? createProjectId("project-1"),
    labels: overrides.labels ?? [],
    externalId: overrides.externalId,
    sourceUrl: overrides.sourceUrl,
    createdAt: overrides.createdAt ?? "2026-03-10T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-10T00:00:00.000Z",
  };
}
