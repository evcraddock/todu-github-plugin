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
import { describe, expect, it } from "vitest";

import {
  GITHUB_PROVIDER_NAME,
  GITHUB_REPOSITORY_TARGET_KIND,
  GitHubBindingValidationError,
  GitHubExternalIdError,
  GitHubProviderConfigError,
  createGitHubIssueUpdateFromTask,
  createGitHubSyncProvider,
  createInMemoryGitHubCommentLinkStore,
  createInMemoryGitHubIssueClient,
  createInMemoryGitHubItemLinkStore,
  createLinkFromTask,
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

    await expect(secondProvider.pull(createBinding(), createProject())).resolves.toEqual({
      tasks: [
        expect.objectContaining({
          externalId: "evcraddock/todu-github-plugin#1",
          title: "Persisted issue",
        }),
      ],
      comments: [],
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
    ).resolves.toEqual({ commentLinks: [] });
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
    });
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
  it("pulls GitHub comments as ExternalComment with attribution", async () => {
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
      body: expect.stringContaining("_Synced from GitHub comment by @octocat on"),
      author: "octocat",
    });
    expect(pullResult.comments![0].body).toContain("Hello from GitHub");
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
      externalTaskId: "evcraddock/todu-github-plugin#1",
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

  it("deletes mirrored GitHub comment when todu note is removed", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Issue with deletable comment",
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
          title: "Issue with deletable comment",
          status: "active",
          comments: [
            createNote({
              id: "note-1",
              content: "To be deleted",
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
          title: "Issue with deletable comment",
          status: "active",
          comments: [],
        }),
      ],
      createProject()
    );

    expect(issueClient.snapshotComments(repositoryTarget(), 1)).toHaveLength(0);
    expect(provider.getState().commentLinks).toHaveLength(0);
  });

  it("detects deleted GitHub comments during pull and removes comment links", async () => {
    const issueClient = createInMemoryGitHubIssueClient();
    issueClient.seedIssues(repositoryTarget(), [
      createIssue({
        number: 1,
        title: "Issue with comment to delete on GitHub",
        state: "open",
        labels: ["status:active", "priority:medium"],
      }),
    ]);
    issueClient.seedComments(repositoryTarget(), 1, [
      createGitHubComment({
        id: 200,
        issueNumber: 1,
        body: "Will be deleted",
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

    const secondPull = await provider.pull(createBinding(), createProject());
    expect(secondPull.comments).toHaveLength(0);
    expect(provider.getState().commentLinks).toHaveLength(0);
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
}): Note {
  return {
    id: createNoteId(overrides.id),
    content: overrides.content,
    author: overrides.author,
    tags: [],
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
