import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createIntegrationBindingId,
  createNoteId,
  createProjectId,
  createTaskId,
  type IntegrationBinding,
  type Note,
  type Project,
  type TaskPushPayload,
} from "@todu/core";
import { beforeEach, describe, expect, it } from "vitest";

import { createGitHubApiError } from "@/github-http-client";

import {
  GITHUB_PROVIDER_NAME,
  GITHUB_REPOSITORY_TARGET_KIND,
  GitHubBindingValidationError,
  GitHubExternalIdError,
  GitHubProviderConfigError,
  createGitHubIssueUpdateFromTask,
  createGitHubSyncProvider,
  createInMemoryBindingRuntimeStore,
  createInMemoryGitHubCommentLinkStore,
  createInMemoryGitHubIssueClient,
  createInMemoryGitHubItemLinkStore,
  createLinkFromTask,
  createLoopPreventionStore,
  formatAttributedBody,
  formatGitHubAttribution,
  formatToduAttribution,
  getNormalGitHubLabels,
  loadGitHubProviderSettings,
  normalizeGitHubIssuePriority,
  normalizeGitHubIssueStatus,
  parseGitHubBinding,
  parseGitHubRepositoryTargetRef,
  parseIssueExternalId,
  stripAttribution,
  type GitHubComment,
} from "@/index";

beforeEach(() => {
  const storageDirectory = path.join(process.cwd(), ".todu-github-plugin");
  fs.mkdirSync(storageDirectory, { recursive: true });
  fs.rmSync(path.join(storageDirectory, "item-links.json"), { force: true });
  fs.rmSync(path.join(storageDirectory, "comment-links.json"), { force: true });
  fs.rmSync(path.join(storageDirectory, "runtime-state.json"), { force: true });
});

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
  it("loads token and default storage path from provider settings", () => {
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

describe("field normalization", () => {
  it("normalizes conflicting status labels deterministically and trusts closed state", () => {
    expect(normalizeGitHubIssueStatus("closed", ["status:active"])).toEqual({
      state: "closed",
      status: "done",
      statusLabel: "status:done",
    });
  });

  it("normalizes conflicting priority labels and keeps only normal labels separate", () => {
    expect(normalizeGitHubIssuePriority(["priority:low", "priority:high", "bug"]).priority).toBe(
      "high"
    );
    expect(
      getNormalGitHubLabels(["priority:low", "priority:high", "bug", "status:active"])
    ).toEqual(["bug"]);
  });

  it("maps todu task fields to GitHub issue updates without syncing assignees back", () => {
    expect(
      createGitHubIssueUpdateFromTask(
        createTaskWithDetail({
          id: "task-1",
          title: "Field sync task",
          description: "Markdown body",
          status: "done",
          priority: "high",
          labels: ["bug", "priority:low", "status:waiting"],
          assignees: ["alice", "bob"],
        })
      )
    ).toEqual({
      title: "Field sync task",
      body: "Markdown body",
      state: "closed",
      labels: ["bug", "status:done", "priority:high"],
    });
  });
});

describe("createGitHubSyncProvider", () => {
  it("pulls linked and bootstrap issues with normalized fields including assignees", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Open issue",
        body: "Imported from GitHub",
        state: "open",
        labels: ["bug", "status:waiting", "priority:high"],
        assignees: ["alice", "bob"],
        updatedAt: "2026-03-10T00:00:00.000Z",
      }),
      createIssue({
        number: 2,
        title: "Closed linked issue",
        body: "Already linked",
        state: "closed",
        labels: ["status:canceled", "priority:low", "enhancement"],
        assignees: ["octocat"],
        updatedAt: "2026-03-10T01:00:00.000Z",
      }),
      createIssue({
        number: 3,
        title: "Pull request",
        body: "Ignored",
        state: "open",
        labels: [],
        isPullRequest: true,
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(
        binding,
        createTaskId("task-linked"),
        "evcraddock",
        "todu-github-plugin",
        2
      )
    );

    const provider = createGitHubSyncProvider({ issueClient, linkStore });

    await provider.initialize({ settings: { token: "secret-token" } });

    const pullResult = await provider.pull(binding, createProject());

    expect(pullResult.tasks).toEqual([
      {
        externalId: "evcraddock/todu-github-plugin#1",
        title: "Open issue",
        description: "Imported from GitHub",
        status: "waiting",
        priority: "high",
        labels: ["bug"],
        assignees: ["alice", "bob"],
        sourceUrl: "https://github.com/evcraddock/todu-github-plugin/issues/1",
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: "2026-03-10T00:00:00.000Z",
        raw: expect.objectContaining({ number: 1 }),
      },
      {
        externalId: "evcraddock/todu-github-plugin#2",
        title: "Closed linked issue",
        description: "Already linked",
        status: "canceled",
        priority: "low",
        labels: ["enhancement"],
        assignees: ["octocat"],
        sourceUrl: "https://github.com/evcraddock/todu-github-plugin/issues/2",
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: "2026-03-10T01:00:00.000Z",
        raw: expect.objectContaining({ number: 2 }),
      },
    ]);
    expect(provider.getState().itemLinks).toHaveLength(2);
  });

  it("bootstraps active/inprogress/waiting tasks into GitHub with normalized non-comment fields", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    const activeTask = createTaskWithDetail({
      id: "task-1",
      title: "Active task",
      description: "Active body",
      status: "active",
      priority: "high",
      labels: ["bug"],
    });
    const doneTask = createTaskWithDetail({
      id: "task-2",
      title: "Done task",
      description: "Done body",
      status: "done",
      labels: ["ignored"],
    });

    await provider.push(createBinding(), [activeTask, doneTask], createProject());

    expect(issueClient.snapshotIssues(repositoryTarget())).toMatchObject([
      {
        number: 1,
        title: "Active task",
        body: "Active body",
        state: "open",
        labels: ["bug", "status:active", "priority:high"],
      },
    ]);
    expect(activeTask.externalId).toBe("evcraddock/todu-github-plugin#1");
    expect(doneTask.externalId).toBeUndefined();
  });

  it("updates linked GitHub issues from task title/body/status/priority/normal labels", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 7,
        title: "Old title",
        body: "Old body",
        state: "open",
        labels: ["status:waiting", "priority:low", "old-label"],
        assignees: ["alice"],
        updatedAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);
    const linkStore = createInMemoryGitHubItemLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(binding, createTaskId("task-7"), "evcraddock", "todu-github-plugin", 7)
    );
    const provider = createGitHubSyncProvider({ issueClient, linkStore });

    await provider.initialize({ settings: { token: "secret-token" } });

    const linkedTask = createTaskWithDetail({
      id: "task-7",
      title: "New title",
      description: "New body",
      status: "done",
      priority: "high",
      labels: ["bug"],
      updatedAt: "2026-03-10T01:00:00.000Z",
    });

    await provider.push(binding, [linkedTask], createProject());

    expect(issueClient.snapshotIssues(repositoryTarget())).toMatchObject([
      {
        number: 7,
        title: "New title",
        body: "New body",
        state: "closed",
        labels: ["bug", "status:done", "priority:high"],
        assignees: ["alice"],
      },
    ]);
    expect(linkedTask.externalId).toBe("evcraddock/todu-github-plugin#7");
  });

  it("skips unchanged linked tasks without reading GitHub issues", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    const binding = createBinding();
    const linkStore = createInMemoryGitHubItemLinkStore();
    linkStore.save(
      createLinkFromTask(
        binding,
        createTaskId("task-7"),
        "evcraddock",
        "todu-github-plugin",
        7,
        "2026-03-10T02:00:00.000Z"
      )
    );

    let getIssueCalls = 0;
    issueClient.getIssue = async () => {
      getIssueCalls += 1;
      throw new Error("getIssue should not be called for unchanged linked tasks");
    };

    const provider = createGitHubSyncProvider({ issueClient, linkStore });
    await provider.initialize({ settings: { token: "secret-token" } });

    await provider.push(
      binding,
      [
        createTaskWithDetail({
          id: "task-7",
          title: "Unchanged title",
          description: "Unchanged body",
          status: "active",
          updatedAt: "2026-03-10T01:00:00.000Z",
        }),
      ],
      createProject()
    );

    expect(getIssueCalls).toBe(0);
    expect(provider.getState().lastPushResult).toMatchObject({
      issueReadCount: 0,
      skippedLinkedTasks: 1,
    });
  });

  it("updates linked issues without reading GitHub issues once mirror state is known", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 7,
        title: "Old title",
        body: "Old body",
        state: "open",
        labels: ["status:active", "priority:medium"],
        updatedAt: "2026-03-10T01:00:00.000Z",
      }),
    ]);
    const binding = createBinding();
    const linkStore = createInMemoryGitHubItemLinkStore();
    linkStore.save(
      createLinkFromTask(
        binding,
        createTaskId("task-7"),
        "evcraddock",
        "todu-github-plugin",
        7,
        "2026-03-10T01:00:00.000Z"
      )
    );

    let getIssueCalls = 0;
    const originalGetIssue = issueClient.getIssue.bind(issueClient);
    issueClient.getIssue = async (target, issueNumber) => {
      getIssueCalls += 1;
      return originalGetIssue(target, issueNumber);
    };

    const provider = createGitHubSyncProvider({ issueClient, linkStore });
    await provider.initialize({ settings: { token: "secret-token" } });

    await provider.push(
      binding,
      [
        createTaskWithDetail({
          id: "task-7",
          title: "New title",
          description: "New body",
          status: "done",
          priority: "high",
          labels: ["bug"],
          updatedAt: "2026-03-10T02:00:00.000Z",
        }),
      ],
      createProject()
    );

    expect(getIssueCalls).toBe(0);
    expect(issueClient.snapshotIssues(repositoryTarget())).toMatchObject([
      {
        number: 7,
        title: "New title",
        body: "New body",
        state: "closed",
        labels: ["bug", "status:done", "priority:high"],
      },
    ]);
    expect(provider.getState().lastPushResult).toMatchObject({
      issueReadCount: 0,
      skippedLinkedTasks: 0,
      updatedIssues: [expect.objectContaining({ number: 7 })],
    });
  });

  it("does not push over a newer GitHub issue when task is older", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 8,
        title: "Remote title",
        body: "Remote body",
        state: "open",
        labels: ["status:inprogress", "priority:medium", "bug"],
        updatedAt: "2026-03-10T05:00:00.000Z",
      }),
    ]);
    const linkStore = createInMemoryGitHubItemLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(binding, createTaskId("task-8"), "evcraddock", "todu-github-plugin", 8)
    );
    const provider = createGitHubSyncProvider({ issueClient, linkStore });

    await provider.initialize({ settings: { token: "secret-token" } });

    await provider.push(
      binding,
      [
        createTaskWithDetail({
          id: "task-8",
          title: "Local older title",
          description: "Local older body",
          status: "done",
          priority: "high",
          labels: ["enhancement"],
          updatedAt: "2026-03-10T04:00:00.000Z",
        }),
      ],
      createProject()
    );

    expect(issueClient.snapshotIssues(repositoryTarget())).toMatchObject([
      {
        number: 8,
        title: "Remote title",
        body: "Remote body",
        state: "open",
        labels: ["status:inprogress", "priority:medium", "bug"],
      },
    ]);
  });

  it("imports GitHub assignees into todu task metadata and does not sync task assignees back", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 9,
        title: "Assignee issue",
        body: "Body",
        state: "open",
        labels: ["status:active", "priority:medium"],
        assignees: ["alice", "bob"],
      }),
    ]);
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    const pullResult = await provider.pull(createBinding(), createProject());
    const mappedTask = provider.mapToTask(pullResult.tasks[0], createProject());

    expect(mappedTask.assignees).toEqual(["alice", "bob"]);

    const taskForPush = createTaskWithDetail({
      id: "task-9",
      title: "Push task",
      description: "Body",
      status: "active",
      assignees: ["charlie"],
    });
    const externalTask = provider.mapFromTask(taskForPush, createProject());
    expect(externalTask.assignees).toBeUndefined();
  });

  it("follows the duplicate policy by creating a new issue instead of fuzzy matching by title", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Duplicate title",
        body: "Existing issue",
        state: "open",
        labels: ["status:active", "priority:medium"],
      }),
    ]);
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });
    const duplicateTask = createTaskWithDetail({
      id: "task-dup",
      title: "Duplicate title",
      description: "New task body",
      status: "active",
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    await provider.push(createBinding(), [duplicateTask], createProject());

    expect(issueClient.snapshotIssues(repositoryTarget())).toMatchObject([
      { number: 1, title: "Duplicate title" },
      { number: 2, title: "Duplicate title" },
    ]);
    expect(duplicateTask.externalId).toBe("evcraddock/todu-github-plugin#2");
  });

  it("persists item links in file-backed local runtime storage across provider instances", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "todu-github-plugin-"));
    const storagePath = path.join(tempDirectory, "item-links.json");
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Persisted issue",
        body: "Body",
        state: "open",
        labels: ["status:active", "priority:medium"],
      }),
    ]);

    const firstProvider = createGitHubSyncProvider({ issueClient });
    await firstProvider.initialize({ settings: { token: "secret-token", storagePath } });
    await firstProvider.pull(createBinding(), createProject());

    expect(fs.existsSync(storagePath)).toBe(true);

    const secondProvider = createGitHubSyncProvider({ issueClient });
    await secondProvider.initialize({ settings: { token: "secret-token", storagePath } });

    expect(secondProvider.getState().itemLinks).toEqual([
      {
        bindingId: createIntegrationBindingId("binding-1"),
        taskId: createTaskId("github:evcraddock/todu-github-plugin#1"),
        issueNumber: 1,
        externalId: "evcraddock/todu-github-plugin#1",
        lastMirroredAt: "2026-03-10T00:00:00.000Z",
      },
    ]);
  });

  it("respects binding strategy for pull, push, and none", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Strategy issue",
        body: "Body",
        state: "open",
        labels: ["status:active", "priority:medium"],
      }),
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
        [
          createTaskWithDetail({
            id: "task-strategy",
            title: "Should not export",
            status: "active",
          }),
        ],
        createProject()
      )
    ).resolves.toEqual({ commentLinks: [], taskLinks: [] });
    await expect(
      provider.pull(createBinding({ strategy: "none" }), createProject())
    ).resolves.toEqual({
      tasks: [],
    });

    expect(issueClient.snapshotIssues(repositoryTarget())).toHaveLength(1);
    expect(provider.getState().lastPushResult).toEqual({
      createdIssues: [],
      updatedIssues: [],
      createdLinks: [],
      taskUpdates: [],
      hydratedLinkedTasks: 0,
      issueReadCount: 0,
      skippedLinkedTasks: 0,
    });
  });
});

describe("local provider state persistence", () => {
  it("persists item links, comment links, and runtime state across provider instances", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "todu-github-plugin-"));
    const storagePath = path.join(tempDirectory, "item-links.json");
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Persisted issue",
        body: "Body",
        state: "open",
        labels: ["status:active", "priority:medium"],
      }),
    ]);
    issueClient.seedComments(repositoryTarget(), 1, [
      createGitHubComment({
        id: 100,
        issueNumber: 1,
        body: "Persisted comment",
        author: "octocat",
      }),
    ]);

    const firstProvider = createGitHubSyncProvider({ issueClient });
    await firstProvider.initialize({ settings: { token: "secret-token", storagePath } });
    await firstProvider.pull(createBinding(), createProject());

    expect(fs.existsSync(storagePath)).toBe(true);
    expect(fs.existsSync(path.join(tempDirectory, "comment-links.json"))).toBe(true);
    expect(fs.existsSync(path.join(tempDirectory, "runtime-state.json"))).toBe(true);

    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Persisted issue",
        body: "Body",
        state: "open",
        labels: ["status:active", "priority:medium"],
      }),
      createIssue({
        number: 2,
        title: "New issue after restart",
        body: "Body",
        state: "open",
        labels: ["status:active", "priority:medium"],
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ]);

    const secondProvider = createGitHubSyncProvider({ issueClient });
    await secondProvider.initialize({ settings: { token: "secret-token", storagePath } });

    const listCommentsCalls: number[] = [];
    const originalListComments = issueClient.listComments.bind(issueClient);
    issueClient.listComments = async (target, issueNumber, options) => {
      listCommentsCalls.push(issueNumber);
      return originalListComments(target, issueNumber, options);
    };

    await expect(secondProvider.pull(createBinding(), createProject())).resolves.toEqual({
      tasks: [
        expect.objectContaining({
          externalId: "evcraddock/todu-github-plugin#2",
          title: "New issue after restart",
        }),
      ],
      comments: [],
    });
    expect(listCommentsCalls).toEqual([2]);
    expect(secondProvider.getState().itemLinks).toEqual([
      {
        bindingId: createIntegrationBindingId("binding-1"),
        taskId: createTaskId("github:evcraddock/todu-github-plugin#1"),
        issueNumber: 1,
        externalId: "evcraddock/todu-github-plugin#1",
        lastMirroredAt: "2026-03-10T00:00:00.000Z",
      },
      {
        bindingId: createIntegrationBindingId("binding-1"),
        taskId: createTaskId("github:evcraddock/todu-github-plugin#2"),
        issueNumber: 2,
        externalId: "evcraddock/todu-github-plugin#2",
        lastMirroredAt: expect.any(String),
      },
    ]);
    expect(secondProvider.getState().commentLinks).toEqual([
      {
        bindingId: createIntegrationBindingId("binding-1"),
        taskId: createTaskId("github:evcraddock/todu-github-plugin#1"),
        noteId: createNoteId("external:100"),
        issueNumber: 1,
        githubCommentId: 100,
        lastMirroredAt: "2026-03-10T00:00:00.000Z",
      },
    ]);
  });
});

describe("comment attribution formatting", () => {
  it("formats GitHub attribution with author and timestamp", () => {
    expect(formatGitHubAttribution("octocat", "2026-03-08T22:00:00Z")).toBe(
      "_Synced from GitHub comment by @octocat on 2026-03-08T22:00:00Z_"
    );
  });

  it("formats todu attribution with author and timestamp", () => {
    expect(formatToduAttribution("alice", "2026-03-08T22:00:00Z")).toBe(
      "_Synced from todu comment by @alice on 2026-03-08T22:00:00Z_"
    );
  });

  it("builds attributed body with header and original content", () => {
    const attribution = formatGitHubAttribution("octocat", "2026-03-08T22:00:00Z");
    expect(formatAttributedBody(attribution, "Hello world")).toBe(
      "_Synced from GitHub comment by @octocat on 2026-03-08T22:00:00Z_\n\nHello world"
    );
  });

  it("strips GitHub attribution from body", () => {
    const body =
      "_Synced from GitHub comment by @octocat on 2026-03-08T22:00:00Z_\n\nOriginal body";
    expect(stripAttribution(body)).toBe("Original body");
  });

  it("strips todu attribution from body", () => {
    const body = "_Synced from todu comment by @alice on 2026-03-08T22:00:00Z_\n\nOriginal body";
    expect(stripAttribution(body)).toBe("Original body");
  });

  it("returns body unchanged when no attribution is present", () => {
    expect(stripAttribution("Just a normal comment")).toBe("Just a normal comment");
  });
});

describe("comment sync", () => {
  it("pulls GitHub comments without visible attribution in the note body", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Issue with comments",
        state: "open",
        labels: ["status:active", "priority:medium"],
      }),
    ]);
    issueClient.seedComments(repositoryTarget(), 1, [
      createGitHubComment({
        id: 100,
        issueNumber: 1,
        body: "Hello from GitHub",
        author: "octocat",
        createdAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);

    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    const pullResult = await provider.pull(createBinding(), createProject());

    expect(pullResult.comments).toHaveLength(1);
    expect(pullResult.comments![0]).toMatchObject({
      externalId: "100",
      externalTaskId: "evcraddock/todu-github-plugin#1",
      body: "Hello from GitHub",
      author: "octocat",
    });
  });

  it("does not push imported GitHub comments back to GitHub when they are tagged", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Issue with imported comment",
        state: "open",
        labels: ["status:active", "priority:medium"],
      }),
    ]);
    issueClient.seedComments(repositoryTarget(), 1, [
      createGitHubComment({
        id: 100,
        issueNumber: 1,
        body: "Hello from GitHub",
        author: "octocat",
        createdAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const commentLinkStore = createInMemoryGitHubCommentLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(binding, createTaskId("task-1"), "evcraddock", "todu-github-plugin", 1)
    );

    const provider = createGitHubSyncProvider({ issueClient, linkStore, commentLinkStore });
    await provider.initialize({ settings: { token: "secret-token" } });

    await provider.pull(binding, createProject());

    const result = await provider.push(
      binding,
      [
        createTaskWithDetail({
          id: "task-1",
          title: "Issue with imported comment",
          status: "active",
          comments: [
            createNote({
              id: "note-imported-1",
              content: "Hello from GitHub",
              author: "octocat",
              tags: ["sync:externalId:100"],
              createdAt: "2026-03-10T00:00:00.000Z",
            }),
          ],
        }),
      ],
      createProject()
    );

    expect(result.commentLinks).toHaveLength(0);
    expect(issueClient.snapshotComments(repositoryTarget(), 1)).toHaveLength(1);
  });

  it("pushes todu comments to GitHub with todu attribution", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Issue for comment push",
        state: "open",
        labels: ["status:active", "priority:medium"],
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(binding, createTaskId("task-1"), "evcraddock", "todu-github-plugin", 1)
    );

    const provider = createGitHubSyncProvider({ issueClient, linkStore });
    await provider.initialize({ settings: { token: "secret-token" } });

    const result = await provider.push(
      binding,
      [
        createTaskWithDetail({
          id: "task-1",
          title: "Issue for comment push",
          status: "active",
          comments: [
            createNote({
              id: "note-1",
              content: "Hello from todu",
              author: "alice",
              createdAt: "2026-03-10T01:00:00.000Z",
            }),
          ],
        }),
      ],
      createProject()
    );

    expect(result.commentLinks).toHaveLength(1);
    expect(result.commentLinks[0]).toMatchObject({
      localNoteId: createNoteId("note-1"),
      externalTaskId: createTaskId("task-1"),
    });

    const ghComments = issueClient.snapshotComments(repositoryTarget(), 1);
    expect(ghComments).toHaveLength(1);
    expect(ghComments[0].body).toContain("_Synced from todu comment by @alice on");
    expect(ghComments[0].body).toContain("Hello from todu");
  });

  it("updates mirrored GitHub comment when todu note is edited", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Issue with editable comment",
        state: "open",
        labels: ["status:active", "priority:medium"],
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const commentLinkStore = createInMemoryGitHubCommentLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(binding, createTaskId("task-1"), "evcraddock", "todu-github-plugin", 1)
    );

    const provider = createGitHubSyncProvider({ issueClient, linkStore, commentLinkStore });
    await provider.initialize({ settings: { token: "secret-token" } });

    await provider.push(
      binding,
      [
        createTaskWithDetail({
          id: "task-1",
          title: "Issue with editable comment",
          status: "active",
          comments: [
            createNote({
              id: "note-1",
              content: "Original content",
              author: "alice",
              createdAt: "2026-03-10T01:00:00.000Z",
            }),
          ],
        }),
      ],
      createProject()
    );

    expect(issueClient.snapshotComments(repositoryTarget(), 1)).toHaveLength(1);
    expect(issueClient.snapshotComments(repositoryTarget(), 1)[0].body).toContain(
      "Original content"
    );

    await provider.push(
      binding,
      [
        createTaskWithDetail({
          id: "task-1",
          title: "Issue with editable comment",
          status: "active",
          comments: [
            createNote({
              id: "note-1",
              content: "Updated content",
              author: "alice",
              createdAt: "2026-03-10T02:00:00.000Z",
            }),
          ],
        }),
      ],
      createProject()
    );

    const ghComments = issueClient.snapshotComments(repositoryTarget(), 1);
    expect(ghComments).toHaveLength(1);
    expect(ghComments[0].body).toContain("Updated content");
    expect(ghComments[0].body).not.toContain("Original content");
  });

  it("does not delete GitHub comment when todu note is removed", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Issue with retained comment",
        state: "open",
        labels: ["status:active", "priority:medium"],
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const commentLinkStore = createInMemoryGitHubCommentLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(binding, createTaskId("task-1"), "evcraddock", "todu-github-plugin", 1)
    );

    const provider = createGitHubSyncProvider({ issueClient, linkStore, commentLinkStore });
    await provider.initialize({ settings: { token: "secret-token" } });

    await provider.push(
      binding,
      [
        createTaskWithDetail({
          id: "task-1",
          title: "Issue with retained comment",
          status: "active",
          comments: [
            createNote({
              id: "note-1",
              content: "Pushed to GitHub",
              author: "alice",
              createdAt: "2026-03-10T01:00:00.000Z",
            }),
          ],
        }),
      ],
      createProject()
    );

    expect(issueClient.snapshotComments(repositoryTarget(), 1)).toHaveLength(1);

    await provider.push(
      binding,
      [
        createTaskWithDetail({
          id: "task-1",
          title: "Issue with retained comment",
          status: "active",
          comments: [],
        }),
      ],
      createProject()
    );

    // Comment is retained on GitHub — deletion during sync is disabled
    expect(issueClient.snapshotComments(repositoryTarget(), 1)).toHaveLength(1);
    // Comment link is also retained
    expect(provider.getState().commentLinks).toHaveLength(1);
  });

  it("preserves comment link when GitHub comment is deleted (deletion detection is disabled)", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Issue with deleted GitHub comment",
        state: "open",
        labels: ["status:active", "priority:medium"],
        updatedAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);
    issueClient.seedComments(repositoryTarget(), 1, [
      createGitHubComment({
        id: 200,
        issueNumber: 1,
        body: "Will be deleted on GitHub",
        author: "octocat",
        createdAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const commentLinkStore = createInMemoryGitHubCommentLinkStore();
    const provider = createGitHubSyncProvider({ issueClient, linkStore, commentLinkStore });
    await provider.initialize({ settings: { token: "secret-token" } });

    const firstPull = await provider.pull(createBinding(), createProject());
    expect(firstPull.comments).toHaveLength(1);
    expect(provider.getState().commentLinks).toHaveLength(1);

    await issueClient.deleteComment(repositoryTarget(), 200);
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Issue with deleted GitHub comment",
        state: "open",
        labels: ["status:active", "priority:medium"],
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ]);

    const secondPull = await provider.pull(createBinding(), createProject());
    // No comment returned (deleted + filtered by since)
    expect(secondPull.comments).toHaveLength(0);
    // Link is preserved — we no longer detect or clean up deleted GitHub comments
    expect(provider.getState().commentLinks).toHaveLength(1);
  });

  it("resolves comment edit conflicts with last-write-wins using timestamps", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Issue with conflict",
        state: "open",
        labels: ["status:active", "priority:medium"],
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const commentLinkStore = createInMemoryGitHubCommentLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(binding, createTaskId("task-1"), "evcraddock", "todu-github-plugin", 1)
    );

    const provider = createGitHubSyncProvider({ issueClient, linkStore, commentLinkStore });
    await provider.initialize({ settings: { token: "secret-token" } });

    await provider.push(
      binding,
      [
        createTaskWithDetail({
          id: "task-1",
          title: "Issue with conflict",
          status: "active",
          comments: [
            createNote({
              id: "note-1",
              content: "First version",
              author: "alice",
              createdAt: "2026-03-10T01:00:00.000Z",
            }),
          ],
        }),
      ],
      createProject()
    );

    const initialComment = issueClient.snapshotComments(repositoryTarget(), 1)[0];
    expect(initialComment.body).toContain("First version");

    await provider.push(
      binding,
      [
        createTaskWithDetail({
          id: "task-1",
          title: "Issue with conflict",
          status: "active",
          comments: [
            createNote({
              id: "note-1",
              content: "Older edit should not overwrite",
              author: "alice",
              createdAt: "2026-03-10T00:30:00.000Z",
            }),
          ],
        }),
      ],
      createProject()
    );

    const afterOlderEdit = issueClient.snapshotComments(repositoryTarget(), 1)[0];
    expect(afterOlderEdit.body).toContain("First version");
    expect(afterOlderEdit.body).not.toContain("Older edit");

    await provider.push(
      binding,
      [
        createTaskWithDetail({
          id: "task-1",
          title: "Issue with conflict",
          status: "active",
          comments: [
            createNote({
              id: "note-1",
              content: "Newer edit should overwrite",
              author: "alice",
              createdAt: "2026-03-10T03:00:00.000Z",
            }),
          ],
        }),
      ],
      createProject()
    );

    const afterNewerEdit = issueClient.snapshotComments(repositoryTarget(), 1)[0];
    expect(afterNewerEdit.body).toContain("Newer edit should overwrite");
  });

  it("maps one GitHub comment to one todu comment and vice versa", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Issue with multiple comments",
        state: "open",
        labels: ["status:active", "priority:medium"],
      }),
    ]);
    issueClient.seedComments(repositoryTarget(), 1, [
      createGitHubComment({
        id: 301,
        issueNumber: 1,
        body: "GitHub comment A",
        author: "octocat",
        createdAt: "2026-03-10T00:00:00.000Z",
      }),
      createGitHubComment({
        id: 302,
        issueNumber: 1,
        body: "GitHub comment B",
        author: "bob",
        createdAt: "2026-03-10T00:01:00.000Z",
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const commentLinkStore = createInMemoryGitHubCommentLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(binding, createTaskId("task-1"), "evcraddock", "todu-github-plugin", 1)
    );

    const provider = createGitHubSyncProvider({ issueClient, linkStore, commentLinkStore });
    await provider.initialize({ settings: { token: "secret-token" } });

    await provider.pull(binding, createProject());

    expect(provider.getState().commentLinks).toHaveLength(2);
    const links = provider.getState().commentLinks;
    const externalIds = links.map((l) => l.githubCommentId);
    expect(externalIds).toContain(301);
    expect(externalIds).toContain(302);

    const result = await provider.push(
      binding,
      [
        createTaskWithDetail({
          id: "task-1",
          title: "Issue with multiple comments",
          status: "active",
          comments: [
            createNote({
              id: "note-push-1",
              content: "Todu comment C",
              author: "charlie",
              createdAt: "2026-03-10T01:00:00.000Z",
            }),
          ],
        }),
      ],
      createProject()
    );

    expect(result.commentLinks).toHaveLength(1);
    expect(result.commentLinks[0].localNoteId).toBe(createNoteId("note-push-1"));

    const ghComments = issueClient.snapshotComments(repositoryTarget(), 1);
    expect(ghComments).toHaveLength(3);
  });
});

describe("runtime integration", () => {
  it("records success in runtime store after a successful pull", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({ number: 1, title: "Issue", state: "open", labels: ["status:active"] }),
    ]);
    const runtimeStore = createInMemoryBindingRuntimeStore();
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
      runtimeStore,
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    await provider.pull(createBinding(), createProject());

    const state = runtimeStore.get(createBinding().id);
    expect(state).not.toBeNull();
    expect(state!.retryAttempt).toBe(0);
    expect(state!.lastSuccessAt).not.toBeNull();
    expect(state!.lastError).toBeNull();
  });

  it("records failure in runtime store when pull throws", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    const originalListIssues = issueClient.listIssues.bind(issueClient);
    let shouldFail = true;
    issueClient.listIssues = async (target) => {
      if (shouldFail) {
        throw new Error("API rate limit exceeded");
      }

      return originalListIssues(target);
    };

    const runtimeStore = createInMemoryBindingRuntimeStore();
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
      runtimeStore,
    });

    await provider.initialize({ settings: { token: "secret-token" } });

    await expect(provider.pull(createBinding(), createProject())).rejects.toThrow(
      "API rate limit exceeded"
    );

    const state = runtimeStore.get(createBinding().id);
    expect(state).not.toBeNull();
    expect(state!.retryAttempt).toBe(1);
    expect(state!.lastError).toBe("API rate limit exceeded");
    expect(state!.nextRetryAt).not.toBeNull();

    shouldFail = false;
  });

  it("uses GitHub rate-limit reset metadata to delay the next retry", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    const resetAt = new Date(Date.now() + 5 * 60 * 1000);
    resetAt.setMilliseconds(0);
    const resetAtHeader = String(Math.floor(resetAt.getTime() / 1000));

    issueClient.listIssues = async () => {
      const headers = new Headers({
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": resetAtHeader,
      });

      throw createGitHubApiError({
        status: 403,
        method: "GET",
        path: "/repos/evcraddock/todu-github-plugin/issues?state=all",
        responseBody: '{"message":"API rate limit exceeded"}',
        headers,
      });
    };

    const runtimeStore = createInMemoryBindingRuntimeStore();
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
      runtimeStore,
      retryConfig: { initialSeconds: 5, maxSeconds: 60 },
    });

    await provider.initialize({ settings: { token: "secret-token" } });

    await expect(provider.pull(createBinding(), createProject())).rejects.toThrow(
      "API rate limit exceeded"
    );

    const state = runtimeStore.get(createBinding().id);
    expect(state).not.toBeNull();
    expect(state!.retryAttempt).toBe(1);
    expect(state!.nextRetryAt).toBe(resetAt.toISOString());
    expect(state!.lastError).toContain(`retry after ${resetAt.toISOString()}`);

    const status = provider.getState().bindingStatuses.get(createBinding().id);
    expect(status?.lastErrorSummary).toContain(`retry after ${resetAt.toISOString()}`);
  });

  it("uses a long fallback cooldown when rate-limit metadata is unavailable", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.listIssues = async () => {
      throw createGitHubApiError({
        status: 403,
        method: "GET",
        path: "/repos/evcraddock/todu-github-plugin/issues?state=all",
        responseBody: '{"message":"API rate limit exceeded"}',
        headers: new Headers(),
        now: new Date("2026-03-10T00:00:00.000Z"),
      });
    };

    const runtimeStore = createInMemoryBindingRuntimeStore();
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
      runtimeStore,
      retryConfig: { initialSeconds: 5, maxSeconds: 60 },
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    await expect(provider.pull(createBinding(), createProject())).rejects.toThrow(
      "API rate limit exceeded"
    );

    const state = runtimeStore.get(createBinding().id);
    expect(state).not.toBeNull();

    const retryDelayMs = Date.parse(state!.nextRetryAt!) - Date.parse(state!.lastAttemptAt!);
    expect(retryDelayMs).toBe(15 * 60 * 1000);
    expect(state!.lastError).toContain("retry delayed due to GitHub rate limit");
  });

  it("skips pull when retry backoff has not elapsed", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({ number: 1, title: "Issue", state: "open", labels: ["status:active"] }),
    ]);

    const originalListIssues = issueClient.listIssues.bind(issueClient);
    let callCount = 0;
    issueClient.listIssues = async (target) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("transient error");
      }

      return originalListIssues(target);
    };

    const runtimeStore = createInMemoryBindingRuntimeStore();
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
      runtimeStore,
      retryConfig: { initialSeconds: 3600, maxSeconds: 3600 },
    });

    await provider.initialize({ settings: { token: "secret-token" } });

    await expect(provider.pull(createBinding(), createProject())).rejects.toThrow();

    const result = await provider.pull(createBinding(), createProject());
    expect(result.tasks).toEqual([]);
    expect(callCount).toBe(1);
  });

  it("records loop prevention writes during push", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    const loopPreventionStore = createLoopPreventionStore();
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
      loopPreventionStore,
    });

    await provider.initialize({ settings: { token: "secret-token" } });

    await provider.push(
      createBinding(),
      [
        createTaskWithDetail({
          id: "task-loop",
          title: "Loop test",
          status: "active",
        }),
      ],
      createProject()
    );

    const writes = loopPreventionStore.listAll();
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0].key).toContain("issue:");
  });

  it("updates binding status through running → idle on success", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({ number: 1, title: "Issue", state: "open", labels: ["status:active"] }),
    ]);
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    await provider.pull(createBinding(), createProject());

    const state = provider.getState();
    const status = state.bindingStatuses.get(createBinding().id);
    expect(status).toBeDefined();
    expect(status!.state).toBe("idle");
    expect(status!.lastSuccessAt).not.toBeNull();
  });

  it("updates binding status to error on failure", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.listIssues = async () => {
      throw new Error("network failure");
    };

    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    await expect(provider.pull(createBinding(), createProject())).rejects.toThrow();

    const state = provider.getState();
    const status = state.bindingStatuses.get(createBinding().id);
    expect(status).toBeDefined();
    expect(status!.state).toBe("error");
    expect(status!.lastErrorSummary).toBe("network failure");
  });

  it("resets retry state after a successful cycle following a failure", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({ number: 1, title: "Issue", state: "open", labels: ["status:active"] }),
    ]);

    let shouldFail = true;
    const originalListIssues = issueClient.listIssues.bind(issueClient);
    issueClient.listIssues = async (target) => {
      if (shouldFail) {
        throw new Error("transient");
      }

      return originalListIssues(target);
    };

    const runtimeStore = createInMemoryBindingRuntimeStore();
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
      runtimeStore,
      retryConfig: { initialSeconds: 0, maxSeconds: 0 },
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    await expect(provider.pull(createBinding(), createProject())).rejects.toThrow();

    const failedState = runtimeStore.get(createBinding().id);
    expect(failedState!.retryAttempt).toBe(1);

    shouldFail = false;
    await provider.pull(createBinding(), createProject());

    const successState = runtimeStore.get(createBinding().id);
    expect(successState!.retryAttempt).toBe(0);
    expect(successState!.lastError).toBeNull();
    expect(successState!.lastSuccessAt).not.toBeNull();
  });
});

describe("reopen and close transitions", () => {
  it("imports a reopened issue as an open status", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Reopened issue",
        state: "open",
        labels: ["status:active"],
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(binding, createTaskId("task-1"), "evcraddock", "todu-github-plugin", 1)
    );

    const provider = createGitHubSyncProvider({ issueClient, linkStore });
    await provider.initialize({ settings: { token: "secret-token" } });
    const result = await provider.pull(binding, createProject());

    expect(result.tasks[0].status).toBe("active");
  });

  it("maps a closed issue without status label to done", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({ number: 1, title: "Closed no label", state: "closed", labels: [] }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(binding, createTaskId("task-1"), "evcraddock", "todu-github-plugin", 1)
    );

    const provider = createGitHubSyncProvider({ issueClient, linkStore });
    await provider.initialize({ settings: { token: "secret-token" } });
    const result = await provider.pull(binding, createProject());

    expect(result.tasks[0].status).toBe("done");
  });

  it("maps a closed canceled issue to canceled", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Canceled",
        state: "closed",
        labels: ["status:canceled"],
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(binding, createTaskId("task-1"), "evcraddock", "todu-github-plugin", 1)
    );

    const provider = createGitHubSyncProvider({ issueClient, linkStore });
    await provider.initialize({ settings: { token: "secret-token" } });
    const result = await provider.pull(binding, createProject());

    expect(result.tasks[0].status).toBe("canceled");
  });

  it("pushes a done task as a closed issue with status:done label", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "To close",
        state: "open",
        labels: ["status:active", "priority:medium"],
        updatedAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(binding, createTaskId("task-1"), "evcraddock", "todu-github-plugin", 1)
    );

    const provider = createGitHubSyncProvider({ issueClient, linkStore });
    await provider.initialize({ settings: { token: "secret-token" } });

    await provider.push(
      binding,
      [
        createTaskWithDetail({
          id: "task-1",
          title: "To close",
          status: "done",
          updatedAt: "2026-03-10T01:00:00.000Z",
        }),
      ],
      createProject()
    );

    const issues = issueClient.snapshotIssues(repositoryTarget());
    expect(issues[0].state).toBe("closed");
    expect(issues[0].labels).toContain("status:done");
  });

  it("pushes a canceled task as a closed issue with status:canceled label", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "To cancel",
        state: "open",
        labels: ["status:active", "priority:medium"],
        updatedAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(binding, createTaskId("task-1"), "evcraddock", "todu-github-plugin", 1)
    );

    const provider = createGitHubSyncProvider({ issueClient, linkStore });
    await provider.initialize({ settings: { token: "secret-token" } });

    await provider.push(
      binding,
      [
        createTaskWithDetail({
          id: "task-1",
          title: "To cancel",
          status: "canceled",
          updatedAt: "2026-03-10T01:00:00.000Z",
        }),
      ],
      createProject()
    );

    const issues = issueClient.snapshotIssues(repositoryTarget());
    expect(issues[0].state).toBe("closed");
    expect(issues[0].labels).toContain("status:canceled");
  });
});

describe("label normalization edge cases", () => {
  it("normalizes conflicting open status labels using precedence active > inprogress > waiting", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Multi status",
        state: "open",
        labels: ["status:waiting", "status:active", "status:inprogress"],
      }),
    ]);

    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    const result = await provider.pull(createBinding(), createProject());

    expect(result.tasks[0].status).toBe("active");
  });

  it("normalizes conflicting closed status labels using precedence done > canceled", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Multi closed status",
        state: "closed",
        labels: ["status:canceled", "status:done"],
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(binding, createTaskId("task-1"), "evcraddock", "todu-github-plugin", 1)
    );

    const provider = createGitHubSyncProvider({ issueClient, linkStore });
    await provider.initialize({ settings: { token: "secret-token" } });
    const result = await provider.pull(binding, createProject());

    expect(result.tasks[0].status).toBe("done");
  });

  it("trusts GitHub closed state over open status label", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Closed but labeled active",
        state: "closed",
        labels: ["status:active"],
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const binding = createBinding();
    linkStore.save(
      createLinkFromTask(binding, createTaskId("task-1"), "evcraddock", "todu-github-plugin", 1)
    );

    const provider = createGitHubSyncProvider({ issueClient, linkStore });
    await provider.initialize({ settings: { token: "secret-token" } });
    const result = await provider.pull(binding, createProject());

    expect(result.tasks[0].status).toBe("done");
  });

  it("strips reserved labels from normal labels in pull", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Mixed labels",
        state: "open",
        labels: ["bug", "status:active", "priority:high", "enhancement"],
      }),
    ]);

    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    const result = await provider.pull(createBinding(), createProject());

    expect(result.tasks[0].labels).toEqual(["bug", "enhancement"]);
    expect(result.tasks[0].labels).not.toContain("status:active");
    expect(result.tasks[0].labels).not.toContain("priority:high");
  });

  it("defaults priority to medium when no priority label is present", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "No priority",
        state: "open",
        labels: ["status:active"],
      }),
    ]);

    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    const result = await provider.pull(createBinding(), createProject());

    expect(result.tasks[0].priority).toBe("medium");
  });
});

describe("multi-cycle steady-state sync", () => {
  it("pull then push then pull again produces consistent state", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Steady state issue",
        state: "open",
        labels: ["status:active", "priority:medium", "bug"],
        updatedAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const provider = createGitHubSyncProvider({ issueClient, linkStore });
    await provider.initialize({ settings: { token: "secret-token" } });

    const firstPull = await provider.pull(createBinding(), createProject());
    expect(firstPull.tasks).toHaveLength(1);
    expect(firstPull.tasks[0].title).toBe("Steady state issue");

    await provider.push(
      createBinding(),
      [
        createTaskWithDetail({
          id: "task-new",
          title: "New from todu",
          status: "active",
        }),
      ],
      createProject()
    );

    expect(issueClient.snapshotIssues(repositoryTarget())).toHaveLength(2);

    const secondPull = await provider.pull(createBinding(), createProject());
    // Incremental: only the newly created issue is returned (updated since last success)
    expect(secondPull.tasks).toHaveLength(1);
    expect(secondPull.tasks[0].title).toBe("New from todu");
  });

  it("updates from both sides converge after multiple cycles", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Original title",
        body: "Original body",
        state: "open",
        labels: ["status:active", "priority:medium"],
        updatedAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);

    const linkStore = createInMemoryGitHubItemLinkStore();
    const provider = createGitHubSyncProvider({ issueClient, linkStore });
    await provider.initialize({ settings: { token: "secret-token" } });

    await provider.pull(createBinding(), createProject());

    await provider.push(
      createBinding(),
      [
        createTaskWithDetail({
          id: "github:evcraddock/todu-github-plugin#1",
          title: "Updated title",
          description: "Updated body",
          status: "inprogress",
          priority: "high",
          labels: ["bug"],
          updatedAt: "2026-03-10T02:00:00.000Z",
        }),
      ],
      createProject()
    );

    const issues = issueClient.snapshotIssues(repositoryTarget());
    expect(issues[0].title).toBe("Updated title");
    expect(issues[0].labels).toContain("status:inprogress");
    expect(issues[0].labels).toContain("priority:high");

    issueClient.seedIssues(repositoryTarget(), [
      {
        ...issues[0],
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ]);

    const finalPull = await provider.pull(createBinding(), createProject());
    expect(finalPull.tasks[0].title).toBe("Updated title");
    expect(finalPull.tasks[0].status).toBe("inprogress");
    expect(finalPull.tasks[0].priority).toBe("high");
  });
});

describe("closed bootstrap import", () => {
  it("keeps default bootstrap behavior and skips unlinked closed issues", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Closed issue",
        state: "closed",
        labels: ["status:done"],
        updatedAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);
    issueClient.seedComments(repositoryTarget(), 1, [
      createGitHubComment({
        id: 100,
        issueNumber: 1,
        body: "Historical comment",
        author: "octocat",
        createdAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);

    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    const result = await provider.pull(createBinding(), createProject());

    expect(result.tasks).toHaveLength(0);
    expect(result.comments).toHaveLength(0);
    expect(provider.getState().itemLinks).toHaveLength(0);
    expect(provider.getState().commentLinks).toHaveLength(0);
  });

  it("imports closed issues and comments during initial bootstrap when opted in", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Canceled issue",
        body: "Imported from GitHub",
        state: "closed",
        labels: ["status:canceled", "priority:low", "enhancement"],
        updatedAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);
    issueClient.seedComments(repositoryTarget(), 1, [
      createGitHubComment({
        id: 100,
        issueNumber: 1,
        body: "Historical comment",
        author: "octocat",
        createdAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);

    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    const result = await provider.pull(
      createBinding({ options: { importClosedOnBootstrap: true } }),
      createProject()
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      title: "Canceled issue",
      status: "canceled",
      priority: "low",
      labels: ["enhancement"],
    });
    expect(result.comments).toHaveLength(1);
    expect(result.comments![0]).toMatchObject({
      externalId: "100",
      externalTaskId: "evcraddock/todu-github-plugin#1",
      author: "octocat",
    });
    expect(result.comments![0].body).toContain("Historical comment");
    expect(provider.getState().itemLinks).toHaveLength(1);
    expect(provider.getState().commentLinks).toHaveLength(1);
  });

  it("limits closed issue bootstrap import to the first successful pull", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });

    const binding = createBinding({ options: { importClosedOnBootstrap: true } });
    const firstPull = await provider.pull(binding, createProject());
    expect(firstPull.tasks).toHaveLength(0);

    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Closed after bootstrap",
        state: "closed",
        labels: ["status:done"],
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ]);
    issueClient.seedComments(repositoryTarget(), 1, [
      createGitHubComment({
        id: 101,
        issueNumber: 1,
        body: "Should stay unimported",
        author: "octocat",
        createdAt: "2026-03-10T01:00:00.000Z",
      }),
    ]);

    const secondPull = await provider.pull(binding, createProject());

    expect(secondPull.tasks).toHaveLength(0);
    expect(secondPull.comments).toHaveLength(0);
    expect(provider.getState().itemLinks).toHaveLength(0);
    expect(provider.getState().commentLinks).toHaveLength(0);
  });
});

describe("incremental sync", () => {
  it("first pull fetches all issues (no since parameter)", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Old issue",
        state: "open",
        labels: ["status:active"],
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
      createIssue({
        number: 2,
        title: "New issue",
        state: "open",
        labels: ["status:active"],
        updatedAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);

    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });
    const result = await provider.pull(createBinding(), createProject());

    expect(result.tasks).toHaveLength(2);
  });

  it("subsequent pull only fetches issues updated since last success", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Unchanged issue",
        state: "open",
        labels: ["status:active"],
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    ]);

    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });

    const firstPull = await provider.pull(createBinding(), createProject());
    expect(firstPull.tasks).toHaveLength(1);

    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Unchanged issue",
        state: "open",
        labels: ["status:active"],
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
      createIssue({
        number: 2,
        title: "Newly created issue",
        state: "open",
        labels: ["status:active"],
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ]);

    const secondPull = await provider.pull(createBinding(), createProject());
    // Only the new issue is returned (updated after first pull's success timestamp)
    expect(secondPull.tasks).toHaveLength(1);
    expect(secondPull.tasks[0].title).toBe("Newly created issue");
  });

  it("subsequent pull only fetches comments for issues changed in the current cycle", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Unchanged issue",
        state: "open",
        labels: ["status:active"],
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
      createIssue({
        number: 2,
        title: "Changed issue",
        state: "open",
        labels: ["status:active"],
        updatedAt: "2026-03-10T00:00:00.000Z",
      }),
    ]);
    issueClient.seedComments(repositoryTarget(), 1, [
      createGitHubComment({
        id: 100,
        issueNumber: 1,
        body: "Comment on unchanged issue",
        author: "octocat",
      }),
    ]);
    issueClient.seedComments(repositoryTarget(), 2, [
      createGitHubComment({
        id: 200,
        issueNumber: 2,
        body: "Comment on changed issue",
        author: "octocat",
      }),
    ]);

    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    const listCommentsCalls: number[] = [];
    const originalListComments = issueClient.listComments.bind(issueClient);
    issueClient.listComments = async (target, issueNumber, options) => {
      listCommentsCalls.push(issueNumber);
      return originalListComments(target, issueNumber, options);
    };

    await provider.initialize({ settings: { token: "secret-token" } });

    const firstPull = await provider.pull(createBinding(), createProject());
    expect(firstPull.comments).toHaveLength(2);
    listCommentsCalls.length = 0;

    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Unchanged issue",
        state: "open",
        labels: ["status:active"],
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
      createIssue({
        number: 2,
        title: "Changed issue",
        state: "open",
        labels: ["status:active"],
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ]);

    const secondPull = await provider.pull(createBinding(), createProject());

    // Only changed issue #2 triggers a listComments call
    expect(listCommentsCalls).toEqual([2]);
    expect(secondPull.tasks).toHaveLength(1);
    expect(secondPull.tasks[0].title).toBe("Changed issue");
    // The existing comment on issue #2 was created before lastSuccessAt, so since-filtering
    // excludes it — only genuinely new/updated comments are returned
    expect(secondPull.comments).toHaveLength(0);
  });

  it("subsequent pull skips comment fetches when no issues changed", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Unchanged issue",
        state: "open",
        labels: ["status:active"],
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    ]);
    issueClient.seedComments(repositoryTarget(), 1, [
      createGitHubComment({
        id: 100,
        issueNumber: 1,
        body: "Existing comment",
        author: "octocat",
      }),
    ]);

    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    const listCommentsCalls: number[] = [];
    const originalListComments = issueClient.listComments.bind(issueClient);
    issueClient.listComments = async (target, issueNumber) => {
      listCommentsCalls.push(issueNumber);
      return originalListComments(target, issueNumber);
    };

    await provider.initialize({ settings: { token: "secret-token" } });

    const firstPull = await provider.pull(createBinding(), createProject());
    expect(firstPull.comments).toHaveLength(1);
    listCommentsCalls.length = 0;

    const secondPull = await provider.pull(createBinding(), createProject());

    expect(secondPull.tasks).toHaveLength(0);
    expect(secondPull.comments).toHaveLength(0);
    expect(listCommentsCalls).toEqual([]);
  });

  it("passes lastSuccessAt as since to listComments on subsequent pull", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Issue with comments",
        state: "open",
        labels: ["status:active"],
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ]);
    issueClient.seedComments(repositoryTarget(), 1, [
      createGitHubComment({
        id: 100,
        issueNumber: 1,
        body: "Old comment",
        author: "octocat",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    ]);

    const runtimeStore = createInMemoryBindingRuntimeStore();
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
      runtimeStore,
    });

    await provider.initialize({ settings: { token: "secret-token" } });

    // First pull: no since, fetches all comments
    const firstPull = await provider.pull(createBinding(), createProject());
    expect(firstPull.comments).toHaveLength(1);

    const capturedOptions: Array<{ since?: string }> = [];
    const originalListComments = issueClient.listComments.bind(issueClient);
    issueClient.listComments = async (target, issueNumber, options) => {
      capturedOptions.push(options ?? {});
      return originalListComments(target, issueNumber, options);
    };

    // Issue changes so it appears in next pull
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Issue with comments",
        state: "open",
        labels: ["status:active"],
        updatedAt: new Date(Date.now() + 120_000).toISOString(),
      }),
    ]);

    await provider.pull(createBinding(), createProject());

    const lastSuccessAt = runtimeStore.get(createBinding().id)?.lastSuccessAt;
    expect(lastSuccessAt).toBeTruthy();
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].since).toBe(lastSuccessAt);
  });

  it("pulls all issues after a failed cycle resets since", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Issue",
        state: "open",
        labels: ["status:active"],
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    ]);

    let shouldFail = false;
    const originalListIssues = issueClient.listIssues.bind(issueClient);
    issueClient.listIssues = async (target, options) => {
      if (shouldFail) {
        throw new Error("transient");
      }

      return originalListIssues(target, options);
    };

    const runtimeStore = createInMemoryBindingRuntimeStore();
    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
      runtimeStore,
      retryConfig: { initialSeconds: 0, maxSeconds: 0 },
    });

    await provider.initialize({ settings: { token: "secret-token" } });

    // First pull succeeds, sets lastSuccessAt
    const firstPull = await provider.pull(createBinding(), createProject());
    expect(firstPull.tasks).toHaveLength(1);

    // Second pull fails
    shouldFail = true;
    await expect(provider.pull(createBinding(), createProject())).rejects.toThrow();

    // Failure doesn't update lastSuccessAt, so next pull still uses the old timestamp
    shouldFail = false;
    const thirdPull = await provider.pull(createBinding(), createProject());
    // Issue hasn't changed since first success, so incremental returns nothing
    expect(thirdPull.tasks).toHaveLength(0);
  });
});

describe("failure path coverage", () => {
  it("propagates issue client errors from pull without corrupting state", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.listIssues = async () => {
      throw new Error("GitHub 500");
    };

    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });

    await expect(provider.pull(createBinding(), createProject())).rejects.toThrow("GitHub 500");

    expect(provider.getState().lastPullResult).toBeNull();
  });

  it("propagates issue client errors from push without corrupting state", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.createIssue = async () => {
      throw new Error("GitHub 502");
    };

    const provider = createGitHubSyncProvider({
      issueClient,
      linkStore: createInMemoryGitHubItemLinkStore(),
    });

    await provider.initialize({ settings: { token: "secret-token" } });

    await expect(
      provider.push(
        createBinding(),
        [createTaskWithDetail({ id: "task-fail", title: "Fail", status: "active" })],
        createProject()
      )
    ).rejects.toThrow("GitHub 502");

    expect(provider.getState().lastPushResult).toBeNull();
  });

  it("throws when pull is called before initialize", async () => {
    const provider = createGitHubSyncProvider();

    await expect(provider.pull(createBinding(), createProject())).rejects.toThrow(
      /not initialized/
    );
  });

  it("throws when push is called before initialize", async () => {
    const provider = createGitHubSyncProvider();

    await expect(provider.push(createBinding(), [], createProject())).rejects.toThrow(
      /not initialized/
    );
  });
});

function createBinding(overrides: Partial<IntegrationBinding> = {}): IntegrationBinding {
  return {
    id: overrides.id ?? createIntegrationBindingId("binding-1"),
    provider: overrides.provider ?? GITHUB_PROVIDER_NAME,
    projectId: overrides.projectId ?? createProjectId("project-1"),
    targetKind: overrides.targetKind ?? GITHUB_REPOSITORY_TARGET_KIND,
    targetRef: overrides.targetRef ?? "evcraddock/todu-github-plugin",
    strategy: overrides.strategy ?? "bidirectional",
    enabled: overrides.enabled ?? true,
    options: overrides.options,
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

function createTaskWithDetail(
  overrides: {
    id: string;
    title: string;
    status: TaskPushPayload["status"];
    description?: string;
    comments?: Note[];
  } & Partial<Omit<TaskPushPayload, "id" | "title" | "status" | "description" | "comments">>
): TaskPushPayload {
  return {
    id: createTaskId(overrides.id),
    title: overrides.title,
    status: overrides.status,
    priority: overrides.priority ?? "medium",
    projectId: overrides.projectId ?? createProjectId("project-1"),
    labels: overrides.labels ?? [],
    assignees: overrides.assignees ?? [],
    externalId: overrides.externalId,
    sourceUrl: overrides.sourceUrl,
    description: overrides.description,
    comments: overrides.comments ?? [],
    createdAt: overrides.createdAt ?? "2026-03-10T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-10T00:00:00.000Z",
  };
}

function createIssue(overrides: {
  number: number;
  title: string;
  state: "open" | "closed";
  body?: string;
  labels?: string[];
  assignees?: string[];
  isPullRequest?: boolean;
  updatedAt?: string;
  createdAt?: string;
}) {
  return {
    number: overrides.number,
    externalId: `evcraddock/todu-github-plugin#${overrides.number}`,
    title: overrides.title,
    body: overrides.body,
    state: overrides.state,
    labels: overrides.labels ?? [],
    assignees: overrides.assignees ?? [],
    sourceUrl: `https://github.com/evcraddock/todu-github-plugin/issues/${overrides.number}`,
    createdAt: overrides.createdAt ?? "2026-03-10T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-10T00:00:00.000Z",
    isPullRequest: overrides.isPullRequest,
  };
}

function createNote(overrides: {
  id: string;
  content: string;
  author: string;
  createdAt?: string;
  tags?: string[];
}): Note {
  return {
    id: createNoteId(overrides.id),
    content: overrides.content,
    author: overrides.author,
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? "2026-03-10T00:00:00.000Z",
  };
}

function createGitHubComment(overrides: {
  id: number;
  issueNumber: number;
  body: string;
  author: string;
  createdAt?: string;
  updatedAt?: string;
}): GitHubComment {
  return {
    id: overrides.id,
    issueNumber: overrides.issueNumber,
    body: overrides.body,
    author: overrides.author,
    sourceUrl: `https://github.com/evcraddock/todu-github-plugin/issues/${overrides.issueNumber}#issuecomment-${overrides.id}`,
    createdAt: overrides.createdAt ?? "2026-03-10T00:00:00.000Z",
    updatedAt: overrides.updatedAt,
  };
}

function repositoryTarget() {
  return { owner: "evcraddock", repo: "todu-github-plugin" };
}
