import {
  createIntegrationBindingId,
  createProjectId,
  type IntegrationBinding,
  type Project,
} from "@todu/core";
import { describe, expect, it } from "vitest";

import {
  GITHUB_PROVIDER_NAME,
  GITHUB_REPOSITORY_TARGET_KIND,
  GitHubBindingValidationError,
  GitHubProviderConfigError,
  createGitHubSyncProvider,
  loadGitHubProviderSettings,
  parseGitHubBinding,
  parseGitHubRepositoryTargetRef,
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
  it("initializes, validates bindings, and shuts down cleanly", async () => {
    const provider = createGitHubSyncProvider();
    const project = createProject();
    const binding = createBinding();

    await expect(provider.pull(binding, project)).rejects.toThrowError(/not initialized/);

    await provider.initialize({ settings: { token: "secret-token" } });
    expect(provider.getState()).toMatchObject({
      initialized: true,
      settings: { token: "secret-token" },
    });

    await expect(provider.pull(binding, project)).resolves.toEqual({ tasks: [] });
    await expect(provider.push(binding, [], project)).resolves.toBeUndefined();

    await expect(provider.shutdown()).resolves.toBeUndefined();
    expect(provider.getState()).toEqual({ initialized: false, settings: null });

    await expect(provider.shutdown()).resolves.toBeUndefined();
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
