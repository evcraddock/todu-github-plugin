import type { GitHubRepositoryTarget } from "@/github-binding";
import type {
  CreateGitHubIssueInput,
  GitHubComment,
  GitHubIssue,
  GitHubIssueClient,
  ListIssuesOptions,
  UpdateGitHubIssueInput,
} from "@/github-client";

interface GitHubApiIssue {
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  labels: Array<{ name: string } | string>;
  assignees?: Array<{ login: string }>;
  html_url: string;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

interface GitHubApiComment {
  id: number;
  body: string;
  user?: { login: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly responseBody: string;
  readonly isRateLimitError: boolean;
  readonly retryAt: string | null;

  constructor(input: {
    status: number;
    method: string;
    path: string;
    responseBody: string;
    isRateLimitError: boolean;
    retryAt: string | null;
  }) {
    super(`GitHub API ${input.method} ${input.path} failed: ${input.status} ${input.responseBody}`);
    this.name = "GitHubApiError";
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.responseBody = input.responseBody;
    this.isRateLimitError = input.isRateLimitError;
    this.retryAt = input.retryAt;
  }
}

function parseRetryAtFromHeaders(headers: Headers, now: Date = new Date()): string | null {
  const retryAfterHeader = headers.get("retry-after");
  if (retryAfterHeader != null) {
    const retryAfterSeconds = Number.parseInt(retryAfterHeader, 10);
    if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return new Date(now.getTime() + retryAfterSeconds * 1000).toISOString();
    }
  }

  const resetHeader = headers.get("x-ratelimit-reset");
  if (resetHeader != null) {
    const resetSeconds = Number.parseInt(resetHeader, 10);
    if (!Number.isNaN(resetSeconds) && resetSeconds > 0) {
      return new Date(resetSeconds * 1000).toISOString();
    }
  }

  return null;
}

function isRateLimitResponse(status: number, headers: Headers, responseBody: string): boolean {
  if (status === 429) {
    return true;
  }

  if (status !== 403) {
    return false;
  }

  const remainingHeader = headers.get("x-ratelimit-remaining");
  if (remainingHeader === "0") {
    return true;
  }

  return responseBody.toLowerCase().includes("rate limit exceeded");
}

export function createGitHubApiError(input: {
  status: number;
  method: string;
  path: string;
  responseBody: string;
  headers: Headers;
  now?: Date;
}): GitHubApiError {
  const now = input.now ?? new Date();
  const rateLimitError = isRateLimitResponse(input.status, input.headers, input.responseBody);

  return new GitHubApiError({
    status: input.status,
    method: input.method,
    path: input.path,
    responseBody: input.responseBody,
    isRateLimitError: rateLimitError,
    retryAt: rateLimitError ? parseRetryAtFromHeaders(input.headers, now) : null,
  });
}

export function isGitHubRateLimitError(error: unknown): error is GitHubApiError {
  return error instanceof GitHubApiError && error.isRateLimitError;
}

function normalizeLabels(labels: GitHubApiIssue["labels"]): string[] {
  return labels.map((label) => (typeof label === "string" ? label : label.name));
}

function normalizeAssignees(assignees?: Array<{ login: string }>): string[] {
  return (assignees ?? []).map((a) => a.login);
}

function mapApiIssue(target: GitHubRepositoryTarget, raw: GitHubApiIssue): GitHubIssue {
  return {
    number: raw.number,
    externalId: `${target.owner}/${target.repo}#${raw.number}`,
    title: raw.title,
    body: raw.body ?? undefined,
    state: raw.state,
    labels: normalizeLabels(raw.labels),
    assignees: normalizeAssignees(raw.assignees),
    sourceUrl: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    isPullRequest: raw.pull_request != null,
  };
}

function mapApiComment(
  _target: GitHubRepositoryTarget,
  issueNumber: number,
  raw: GitHubApiComment
): GitHubComment {
  return {
    id: raw.id,
    issueNumber,
    body: raw.body,
    author: raw.user?.login ?? "unknown",
    sourceUrl: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function createHttpGitHubIssueClient(token: string): GitHubIssueClient {
  const baseUrl = "https://api.github.com";
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const url = `${baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: {
        ...headers,
        ...(body != null ? { "Content-Type": "application/json" } : {}),
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    };

    const response = await fetch(url, options);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw createGitHubApiError({
        status: response.status,
        method,
        path,
        responseBody: text,
        headers: response.headers,
      });
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  };

  const listAllPages = async <T>(path: string): Promise<T[]> => {
    const results: T[] = [];
    let page = 1;
    const perPage = 100;

    for (;;) {
      const separator = path.includes("?") ? "&" : "?";
      const items = await request<T[]>(
        "GET",
        `${path}${separator}per_page=${perPage}&page=${page}`
      );

      results.push(...items);
      if (items.length < perPage) {
        break;
      }

      page++;
    }

    return results;
  };

  return {
    async listIssues(target, options?: ListIssuesOptions): Promise<GitHubIssue[]> {
      let path = `/repos/${target.owner}/${target.repo}/issues?state=all`;
      if (options?.since) {
        path += `&since=${encodeURIComponent(options.since)}`;
      }

      const rawIssues = await listAllPages<GitHubApiIssue>(path);
      return rawIssues.map((raw) => mapApiIssue(target, raw));
    },

    async getIssue(target, issueNumber): Promise<GitHubIssue | null> {
      try {
        const raw = await request<GitHubApiIssue>(
          "GET",
          `/repos/${target.owner}/${target.repo}/issues/${issueNumber}`
        );

        return mapApiIssue(target, raw);
      } catch (error) {
        if (error instanceof Error && error.message.includes("404")) {
          return null;
        }

        throw error;
      }
    },

    async createIssue(target, input: CreateGitHubIssueInput): Promise<GitHubIssue> {
      const raw = await request<GitHubApiIssue>(
        "POST",
        `/repos/${target.owner}/${target.repo}/issues`,
        {
          title: input.title,
          body: input.body,
          labels: input.labels,
        }
      );

      return mapApiIssue(target, raw);
    },

    async updateIssue(
      target,
      issueNumber: number,
      input: UpdateGitHubIssueInput
    ): Promise<GitHubIssue> {
      const raw = await request<GitHubApiIssue>(
        "PATCH",
        `/repos/${target.owner}/${target.repo}/issues/${issueNumber}`,
        {
          ...(input.title != null ? { title: input.title } : {}),
          ...(input.body != null ? { body: input.body } : {}),
          ...(input.state != null ? { state: input.state } : {}),
          ...(input.labels != null ? { labels: input.labels } : {}),
        }
      );

      return mapApiIssue(target, raw);
    },

    async listComments(target, issueNumber): Promise<GitHubComment[]> {
      const path = `/repos/${target.owner}/${target.repo}/issues/${issueNumber}/comments`;
      const rawComments = await listAllPages<GitHubApiComment>(path);
      return rawComments.map((raw) => mapApiComment(target, issueNumber, raw));
    },

    async createComment(target, issueNumber, body): Promise<GitHubComment> {
      const raw = await request<GitHubApiComment>(
        "POST",
        `/repos/${target.owner}/${target.repo}/issues/${issueNumber}/comments`,
        { body }
      );

      return mapApiComment(target, issueNumber, raw);
    },

    async updateComment(target, commentId, body): Promise<GitHubComment> {
      const raw = await request<GitHubApiComment>(
        "PATCH",
        `/repos/${target.owner}/${target.repo}/issues/comments/${commentId}`,
        { body }
      );

      // The API response doesn't include issueNumber directly, so we use 0.
      // The caller should already know the issue number from the comment link.
      return mapApiComment(target, 0, raw);
    },

    async deleteComment(target, commentId): Promise<void> {
      await request<void>(
        "DELETE",
        `/repos/${target.owner}/${target.repo}/issues/comments/${commentId}`
      );
    },
  };
}
