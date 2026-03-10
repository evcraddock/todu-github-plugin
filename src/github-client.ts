import type { Task } from "@todu/core";

import type { GitHubRepositoryTarget } from "@/github-binding";

export interface GitHubIssue {
  number: number;
  title: string;
  body?: string;
  state: "open" | "closed";
  labels: string[];
  sourceUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  isPullRequest?: boolean;
}

export interface CreateGitHubIssueInput {
  title: string;
  body?: string;
  labels?: string[];
}

export interface GitHubIssueClient {
  listOpenIssues(target: GitHubRepositoryTarget): Promise<GitHubIssue[]>;
  createIssue(target: GitHubRepositoryTarget, task: Task): Promise<GitHubIssue>;
}

export interface InMemoryGitHubIssueClient extends GitHubIssueClient {
  seedIssues(target: GitHubRepositoryTarget, issues: GitHubIssue[]): void;
  snapshotIssues(target: GitHubRepositoryTarget): GitHubIssue[];
}

export function createInMemoryGitHubIssueClient(): InMemoryGitHubIssueClient {
  const issuesByRepository = new Map<string, GitHubIssue[]>();

  const getRepositoryKey = (target: GitHubRepositoryTarget): string =>
    `${target.owner}/${target.repo}`;

  const getIssues = (target: GitHubRepositoryTarget): GitHubIssue[] => {
    const repositoryKey = getRepositoryKey(target);
    return issuesByRepository.get(repositoryKey) ?? [];
  };

  const setIssues = (target: GitHubRepositoryTarget, issues: GitHubIssue[]): void => {
    issuesByRepository.set(getRepositoryKey(target), issues);
  };

  return {
    seedIssues(target, issues): void {
      setIssues(
        target,
        issues.map((issue) => ({
          ...issue,
          labels: [...issue.labels],
        }))
      );
    },
    snapshotIssues(target): GitHubIssue[] {
      return getIssues(target).map((issue) => ({
        ...issue,
        labels: [...issue.labels],
      }));
    },
    async listOpenIssues(target): Promise<GitHubIssue[]> {
      return getIssues(target)
        .filter((issue) => issue.state === "open" && !issue.isPullRequest)
        .map((issue) => ({
          ...issue,
          labels: [...issue.labels],
        }));
    },
    async createIssue(target, task): Promise<GitHubIssue> {
      const issues = getIssues(target);
      const nextIssueNumber = issues.reduce((max, issue) => Math.max(max, issue.number), 0) + 1;
      const timestamp = task.updatedAt;
      const createdIssue: GitHubIssue = {
        number: nextIssueNumber,
        title: task.title,
        body: undefined,
        state: "open",
        labels: [],
        sourceUrl: `https://github.com/${target.owner}/${target.repo}/issues/${nextIssueNumber}`,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      setIssues(target, [...issues, createdIssue]);
      return {
        ...createdIssue,
        labels: [...createdIssue.labels],
      };
    },
  };
}
