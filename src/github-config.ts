import os from "node:os";
import path from "node:path";

import type { SyncProviderConfig } from "@todu/core";

export type GitHubProviderConfigErrorCode = "INVALID_SETTINGS" | "MISSING_TOKEN";

export interface GitHubProviderSettings {
  token: string;
  storagePath: string;
}

export interface GitHubDefaultStoragePathOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

const APP_STATE_DIRECTORY = "todu";
const GITHUB_PLUGIN_STATE_DIRECTORY = "github-plugin";
const ITEM_LINK_STORAGE_FILE = "item-links.json";

function getAbsoluteEnvironmentPath(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.trim() && path.isAbsolute(value) ? value : undefined;
}

function getDefaultStateDirectory({
  env = process.env,
  homeDirectory = os.homedir(),
  platform = os.platform(),
}: GitHubDefaultStoragePathOptions = {}): string {
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", APP_STATE_DIRECTORY);
  }

  if (platform === "win32") {
    const appDataDirectory =
      getAbsoluteEnvironmentPath(env, "LOCALAPPDATA") ??
      getAbsoluteEnvironmentPath(env, "APPDATA") ??
      path.join(homeDirectory, "AppData", "Local");
    return path.join(appDataDirectory, APP_STATE_DIRECTORY);
  }

  const xdgStateHome = getAbsoluteEnvironmentPath(env, "XDG_STATE_HOME");
  return path.join(
    xdgStateHome ?? path.join(homeDirectory, ".local", "state"),
    APP_STATE_DIRECTORY
  );
}

export function getDefaultGitHubStoragePath(options: GitHubDefaultStoragePathOptions = {}): string {
  return path.join(
    getDefaultStateDirectory(options),
    GITHUB_PLUGIN_STATE_DIRECTORY,
    ITEM_LINK_STORAGE_FILE
  );
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

  const storagePath = settings.storagePath;
  if (storagePath !== undefined && (typeof storagePath !== "string" || !storagePath.trim())) {
    throw new GitHubProviderConfigError(
      "INVALID_SETTINGS",
      "Invalid GitHub provider settings: settings.storagePath must be a non-empty string when provided",
      {
        field: "settings.storagePath",
      }
    );
  }

  return {
    token: token.trim(),
    storagePath:
      typeof storagePath === "string" ? storagePath.trim() : getDefaultGitHubStoragePath(),
  };
}
