import type { SyncProviderConfig } from "@todu/core";

export type GitHubProviderConfigErrorCode = "INVALID_SETTINGS" | "MISSING_TOKEN";

export interface GitHubProviderSettings {
  token: string;
}

export class GitHubProviderConfigError extends Error {
  readonly code: GitHubProviderConfigErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: GitHubProviderConfigErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "GitHubProviderConfigError";
    this.code = code;
    this.details = details;
  }
}

export function loadGitHubProviderSettings(config: SyncProviderConfig): GitHubProviderSettings {
  const settings = config.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new GitHubProviderConfigError(
      "INVALID_SETTINGS",
      "Invalid GitHub provider settings: expected an object"
    );
  }

  const token = settings.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new GitHubProviderConfigError(
      "MISSING_TOKEN",
      "Invalid GitHub provider settings: missing non-empty settings.token",
      {
        field: "settings.token",
      }
    );
  }

  return {
    token: token.trim(),
  };
}
