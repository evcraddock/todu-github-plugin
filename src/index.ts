export interface GitHubIssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
}

export function formatIssueExternalId(issue: GitHubIssueRef): string {
  return `${issue.owner}/${issue.repo}#${issue.issueNumber}`;
}
