import type { GitHubRepositoryTarget } from "@/github-binding";

export interface GitHubIssue {
  number: number;
  externalId: string;
  title: string;
  body?: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
  sourceUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  isPullRequest?: boolean;
}

export interface GitHubComment {
  id: number;
  issueNumber: number;
  body: string;
  author: string;
  sourceUrl?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateGitHubIssueInput {
  title: string;
  body?: string;
  state?: GitHubIssue["state"];
  labels?: string[];
}

export interface UpdateGitHubIssueInput {
  title?: string;
  body?: string;
  state?: GitHubIssue["state"];
  labels?: string[];
}

export interface ListIssuesOptions {
  since?: string;
}

export interface GitHubIssueClient {
  listIssues(target: GitHubRepositoryTarget, options?: ListIssuesOptions): Promise<GitHubIssue[]>;
  getIssue(target: GitHubRepositoryTarget, issueNumber: number): Promise<GitHubIssue | null>;
  createIssue(target: GitHubRepositoryTarget, input: CreateGitHubIssueInput): Promise<GitHubIssue>;
  updateIssue(
    target: GitHubRepositoryTarget,
    issueNumber: number,
    input: UpdateGitHubIssueInput
  ): Promise<GitHubIssue>;
  listComments(target: GitHubRepositoryTarget, issueNumber: number): Promise<GitHubComment[]>;
  createComment(
    target: GitHubRepositoryTarget,
    issueNumber: number,
    body: string
  ): Promise<GitHubComment>;
  updateComment(
    target: GitHubRepositoryTarget,
    commentId: number,
    body: string
  ): Promise<GitHubComment>;
  deleteComment(target: GitHubRepositoryTarget, commentId: number): Promise<void>;
}

export interface InMemoryGitHubIssueClient extends GitHubIssueClient {
  seedIssues(target: GitHubRepositoryTarget, issues: GitHubIssue[]): void;
  seedComments(
    target: GitHubRepositoryTarget,
    issueNumber: number,
    comments: GitHubComment[]
  ): void;
  snapshotIssues(target: GitHubRepositoryTarget): GitHubIssue[];
  snapshotComments(target: GitHubRepositoryTarget, issueNumber: number): GitHubComment[];
}

export function createInMemoryGitHubIssueClient(): InMemoryGitHubIssueClient {
  const issuesByRepository = new Map<string, GitHubIssue[]>();
  const commentsByIssue = new Map<string, GitHubComment[]>();
  let nextCommentId = 1;

  const getRepositoryKey = (target: GitHubRepositoryTarget): string =>
    `${target.owner}/${target.repo}`;

  const getCommentKey = (target: GitHubRepositoryTarget, issueNumber: number): string =>
    `${getRepositoryKey(target)}#${issueNumber}`;

  const getIssues = (target: GitHubRepositoryTarget): GitHubIssue[] => {
    const repositoryKey = getRepositoryKey(target);
    return issuesByRepository.get(repositoryKey) ?? [];
  };

  const setIssues = (target: GitHubRepositoryTarget, issues: GitHubIssue[]): void => {
    issuesByRepository.set(getRepositoryKey(target), issues);
  };

  const getComments = (target: GitHubRepositoryTarget, issueNumber: number): GitHubComment[] =>
    commentsByIssue.get(getCommentKey(target, issueNumber)) ?? [];

  const setComments = (
    target: GitHubRepositoryTarget,
    issueNumber: number,
    comments: GitHubComment[]
  ): void => {
    commentsByIssue.set(getCommentKey(target, issueNumber), comments);
  };

  const cloneIssue = (issue: GitHubIssue): GitHubIssue => ({
    ...issue,
    labels: [...issue.labels],
    assignees: [...issue.assignees],
  });

  const cloneComment = (comment: GitHubComment): GitHubComment => ({ ...comment });

  const createIssueSourceUrl = (target: GitHubRepositoryTarget, issueNumber: number): string =>
    `https://github.com/${target.owner}/${target.repo}/issues/${issueNumber}`;

  const createCommentSourceUrl = (
    target: GitHubRepositoryTarget,
    issueNumber: number,
    commentId: number
  ): string =>
    `https://github.com/${target.owner}/${target.repo}/issues/${issueNumber}#issuecomment-${commentId}`;

  const findCommentById = (
    target: GitHubRepositoryTarget,
    commentId: number
  ): { comments: GitHubComment[]; index: number; issueNumber: number } | null => {
    for (const [key, comments] of commentsByIssue.entries()) {
      if (!key.startsWith(getRepositoryKey(target))) {
        continue;
      }

      const index = comments.findIndex((c) => c.id === commentId);
      if (index !== -1) {
        const issueNumber = comments[index].issueNumber;
        return { comments, index, issueNumber };
      }
    }

    return null;
  };

  return {
    seedIssues(target, issues): void {
      setIssues(
        target,
        issues.map((issue) =>
          cloneIssue({
            ...issue,
            externalId: issue.externalId ?? `${target.owner}/${target.repo}#${issue.number}`,
            assignees: [...(issue.assignees ?? [])],
          })
        )
      );
    },
    seedComments(target, issueNumber, comments): void {
      const seeded = comments.map((comment) => {
        const id = comment.id || nextCommentId++;
        if (comment.id && comment.id >= nextCommentId) {
          nextCommentId = comment.id + 1;
        }

        return cloneComment({
          ...comment,
          id,
          issueNumber,
          sourceUrl: comment.sourceUrl ?? createCommentSourceUrl(target, issueNumber, id),
        });
      });

      setComments(target, issueNumber, seeded);
    },
    snapshotIssues(target): GitHubIssue[] {
      return getIssues(target).map(cloneIssue);
    },
    snapshotComments(target, issueNumber): GitHubComment[] {
      return getComments(target, issueNumber).map(cloneComment);
    },
    async listIssues(target, options?): Promise<GitHubIssue[]> {
      return getIssues(target)
        .filter((issue) => !issue.isPullRequest)
        .filter((issue) => {
          if (!options?.since || !issue.updatedAt) {
            return true;
          }

          return issue.updatedAt >= options.since;
        })
        .map(cloneIssue);
    },
    async getIssue(target, issueNumber): Promise<GitHubIssue | null> {
      return getIssues(target)
        .filter((issue) => !issue.isPullRequest)
        .find((issue) => issue.number === issueNumber)
        ? cloneIssue(
            getIssues(target).find((issue) => issue.number === issueNumber && !issue.isPullRequest)!
          )
        : null;
    },
    async createIssue(target, input): Promise<GitHubIssue> {
      const issues = getIssues(target);
      const nextIssueNumber = issues.reduce((max, issue) => Math.max(max, issue.number), 0) + 1;
      const timestamp = new Date().toISOString();
      const createdIssue: GitHubIssue = {
        number: nextIssueNumber,
        externalId: `${target.owner}/${target.repo}#${nextIssueNumber}`,
        title: input.title,
        body: input.body,
        state: input.state ?? "open",
        labels: [...(input.labels ?? [])],
        assignees: [],
        sourceUrl: createIssueSourceUrl(target, nextIssueNumber),
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      setIssues(target, [...issues, createdIssue]);
      return cloneIssue(createdIssue);
    },
    async updateIssue(target, issueNumber, input): Promise<GitHubIssue> {
      const issues = getIssues(target);
      const index = issues.findIndex((issue) => issue.number === issueNumber);
      if (index === -1) {
        throw new Error(`GitHub issue not found: ${target.owner}/${target.repo}#${issueNumber}`);
      }

      const existingIssue = issues[index];
      const updatedIssue: GitHubIssue = {
        ...existingIssue,
        title: input.title ?? existingIssue.title,
        body: input.body ?? existingIssue.body,
        state: input.state ?? existingIssue.state,
        labels: input.labels ? [...input.labels] : [...existingIssue.labels],
        updatedAt: new Date().toISOString(),
      };

      const nextIssues = [...issues];
      nextIssues[index] = updatedIssue;
      setIssues(target, nextIssues);
      return cloneIssue(updatedIssue);
    },
    async listComments(target, issueNumber): Promise<GitHubComment[]> {
      return getComments(target, issueNumber).map(cloneComment);
    },
    async createComment(target, issueNumber, body): Promise<GitHubComment> {
      const comments = getComments(target, issueNumber);
      const commentId = nextCommentId++;
      const timestamp = new Date().toISOString();
      const created: GitHubComment = {
        id: commentId,
        issueNumber,
        body,
        author: "github-token-user",
        sourceUrl: createCommentSourceUrl(target, issueNumber, commentId),
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      setComments(target, issueNumber, [...comments, created]);
      return cloneComment(created);
    },
    async updateComment(target, commentId, body): Promise<GitHubComment> {
      const found = findCommentById(target, commentId);
      if (!found) {
        throw new Error(
          `GitHub comment not found: ${getRepositoryKey(target)} comment ${commentId}`
        );
      }

      const existing = found.comments[found.index];
      const updated: GitHubComment = {
        ...existing,
        body,
        updatedAt: new Date().toISOString(),
      };

      found.comments[found.index] = updated;
      return cloneComment(updated);
    },
    async deleteComment(target, commentId): Promise<void> {
      const found = findCommentById(target, commentId);
      if (!found) {
        throw new Error(
          `GitHub comment not found: ${getRepositoryKey(target)} comment ${commentId}`
        );
      }

      found.comments.splice(found.index, 1);
    },
  };
}
