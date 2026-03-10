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

export interface GitHubIssueClient {
  listIssues(target: GitHubRepositoryTarget): Promise<GitHubIssue[]>;
  getIssue(target: GitHubRepositoryTarget, issueNumber: number): Promise<GitHubIssue | null>;
  createIssue(target: GitHubRepositoryTarget, input: CreateGitHubIssueInput): Promise<GitHubIssue>;
  updateIssue(
    target: GitHubRepositoryTarget,
    issueNumber: number,
    input: UpdateGitHubIssueInput
  ): Promise<GitHubIssue>;
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

  const cloneIssue = (issue: GitHubIssue): GitHubIssue => ({
    ...issue,
    labels: [...issue.labels],
    assignees: [...issue.assignees],
  });

  const createIssueSourceUrl = (target: GitHubRepositoryTarget, issueNumber: number): string =>
    `https://github.com/${target.owner}/${target.repo}/issues/${issueNumber}`;

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
    snapshotIssues(target): GitHubIssue[] {
      return getIssues(target).map(cloneIssue);
    },
    async listIssues(target): Promise<GitHubIssue[]> {
      return getIssues(target)
        .filter((issue) => !issue.isPullRequest)
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
  };
}
