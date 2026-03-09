export interface GitHubIssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
}

export function formatIssueExternalId(issue: GitHubIssueRef): string {
  return `${issue.owner}/${issue.repo}#${issue.issueNumber}`;
}

export {
  GITHUB_PROVIDER_NAME,
  GITHUB_REPOSITORY_TARGET_KIND,
  GitHubBindingValidationError,
  parseGitHubBinding,
  parseGitHubRepositoryTargetRef,
  type GitHubRepositoryBinding,
  type GitHubRepositoryTarget,
} from "@/github-binding";
export {
  GitHubProviderConfigError,
  loadGitHubProviderSettings,
  type GitHubProviderSettings,
} from "@/github-config";
export {
  GITHUB_PROVIDER_VERSION,
  createGitHubSyncProvider,
  githubProvider,
  syncProvider,
  type GitHubProviderState,
  type GitHubSyncProvider,
} from "@/github-provider";
