import type { IntegrationBinding } from "@todu/core";

export const GITHUB_PROVIDER_NAME = "github";
export const GITHUB_REPOSITORY_TARGET_KIND = "repository";

export type GitHubBindingValidationErrorCode =
  | "INVALID_PROVIDER"
  | "INVALID_TARGET_KIND"
  | "INVALID_TARGET_REF";

export interface GitHubRepositoryTarget {
  owner: string;
  repo: string;
}

export interface GitHubRepositoryBinding extends GitHubRepositoryTarget {
  binding: IntegrationBinding;
}

export class GitHubBindingValidationError extends Error {
  readonly code: GitHubBindingValidationErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: GitHubBindingValidationErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "GitHubBindingValidationError";
    this.code = code;
    this.details = details;
  }
}

export function parseGitHubRepositoryTargetRef(targetRef: string): GitHubRepositoryTarget {
  const normalizedTargetRef = targetRef.trim();
  if (!normalizedTargetRef) {
    throw new GitHubBindingValidationError(
      "INVALID_TARGET_REF",
      "Invalid GitHub repository targetRef: value is required",
      {
        targetRef,
      }
    );
  }

  const segments = normalizedTargetRef.split("/");
  if (segments.length !== 2) {
    throw new GitHubBindingValidationError(
      "INVALID_TARGET_REF",
      `Invalid GitHub repository targetRef \`${targetRef}\`: expected owner/repo format`,
      {
        targetRef,
      }
    );
  }

  const [owner, repo] = segments.map((segment) => segment.trim());
  if (!owner || !repo) {
    throw new GitHubBindingValidationError(
      "INVALID_TARGET_REF",
      `Invalid GitHub repository targetRef \`${targetRef}\`: owner and repo must both be non-empty`,
      {
        targetRef,
        owner,
        repo,
      }
    );
  }

  if (owner.includes("/") || repo.includes("/")) {
    throw new GitHubBindingValidationError(
      "INVALID_TARGET_REF",
      `Invalid GitHub repository targetRef \`${targetRef}\`: expected exactly one slash`,
      {
        targetRef,
      }
    );
  }

  return {
    owner,
    repo,
  };
}

export function parseGitHubBinding(binding: IntegrationBinding): GitHubRepositoryBinding {
  if (binding.provider !== GITHUB_PROVIDER_NAME) {
    throw new GitHubBindingValidationError(
      "INVALID_PROVIDER",
      `Invalid GitHub integration binding ${binding.id}: provider must be \`${GITHUB_PROVIDER_NAME}\` (received: \`${binding.provider}\`)`,
      {
        bindingId: binding.id,
        provider: binding.provider,
      }
    );
  }

  if (binding.targetKind !== GITHUB_REPOSITORY_TARGET_KIND) {
    throw new GitHubBindingValidationError(
      "INVALID_TARGET_KIND",
      `Invalid GitHub integration binding ${binding.id}: targetKind must be \`${GITHUB_REPOSITORY_TARGET_KIND}\` (received: \`${binding.targetKind}\`)`,
      {
        bindingId: binding.id,
        targetKind: binding.targetKind,
      }
    );
  }

  const target = parseGitHubRepositoryTargetRef(binding.targetRef);

  return {
    binding,
    owner: target.owner,
    repo: target.repo,
  };
}
