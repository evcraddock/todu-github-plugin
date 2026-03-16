import type {
  ExternalComment,
  IntegrationBinding,
  Note,
  NoteId,
  SyncProviderPushCommentLink,
  TaskPushPayload,
} from "@todu/core";

import type { GitHubComment, GitHubIssueClient } from "@/github-client";
import type { GitHubCommentLink, GitHubCommentLinkStore } from "@/github-comment-links";
import type { GitHubItemLink, GitHubItemLinkStore } from "@/github-links";
import { formatIssueExternalId } from "@/github-ids";

const GITHUB_ATTRIBUTION_PREFIX = "_Synced from GitHub comment by @";
const TODU_ATTRIBUTION_PREFIX = "_Synced from todu comment by @";
const ATTRIBUTION_SUFFIX_PATTERN = / on \d{4}-\d{2}-\d{2}T[\d:.]+Z_$/;
const IMPORTED_COMMENT_LINK_PREFIX = "external:";
const SYNC_EXTERNAL_ID_TAG_PREFIX = "sync:externalId:";

export function formatGitHubAttribution(author: string, timestamp: string): string {
  return `_Synced from GitHub comment by @${author} on ${timestamp}_`;
}

export function formatToduAttribution(author: string, timestamp: string): string {
  return `_Synced from todu comment by @${author} on ${timestamp}_`;
}

export function formatAttributedBody(attribution: string, body: string): string {
  return `${attribution}\n\n${body}`;
}

export function stripAttribution(body: string): string {
  const lines = body.split("\n");
  if (lines.length < 1) {
    return body;
  }

  const firstLine = lines[0];
  if (
    (firstLine.startsWith(GITHUB_ATTRIBUTION_PREFIX) ||
      firstLine.startsWith(TODU_ATTRIBUTION_PREFIX)) &&
    ATTRIBUTION_SUFFIX_PATTERN.test(firstLine)
  ) {
    const remaining = lines.slice(1).join("\n");
    return remaining.startsWith("\n") ? remaining.slice(1) : remaining;
  }

  return body;
}

export function hasGitHubAttribution(body: string): boolean {
  const firstLine = body.split("\n")[0];
  return (
    firstLine.startsWith(GITHUB_ATTRIBUTION_PREFIX) && ATTRIBUTION_SUFFIX_PATTERN.test(firstLine)
  );
}

function isImportedCommentLink(link: GitHubCommentLink): boolean {
  return (link.noteId as string).startsWith(IMPORTED_COMMENT_LINK_PREFIX);
}

function hasImportedGitHubSyncTag(note: Note): boolean {
  return note.tags.some((tag) => tag.startsWith(SYNC_EXTERNAL_ID_TAG_PREFIX));
}

export interface PullCommentsResult {
  comments: ExternalComment[];
  createdLinks: GitHubCommentLink[];
  deletedLinks: GitHubCommentLink[];
}

export async function pullComments(input: {
  binding: IntegrationBinding;
  owner: string;
  repo: string;
  issueClient: GitHubIssueClient;
  itemLinkStore: GitHubItemLinkStore;
  commentLinkStore: GitHubCommentLinkStore;
  issueNumbers?: readonly number[];
}): Promise<PullCommentsResult> {
  const comments: ExternalComment[] = [];
  const createdLinks: GitHubCommentLink[] = [];
  const deletedLinks: GitHubCommentLink[] = [];

  const issueNumbers = input.issueNumbers ? new Set(input.issueNumbers) : null;
  const itemLinks = input.itemLinkStore
    .list(input.binding.id)
    .filter((itemLink) => issueNumbers?.has(itemLink.issueNumber) ?? true);

  for (const itemLink of itemLinks) {
    const githubComments = await input.issueClient.listComments(
      { owner: input.owner, repo: input.repo },
      itemLink.issueNumber
    );
    const existingCommentLinks = input.commentLinkStore.listByIssue(
      input.binding.id,
      itemLink.issueNumber
    );

    const githubCommentIds = new Set(githubComments.map((c) => c.id));

    for (const commentLink of existingCommentLinks) {
      if (!githubCommentIds.has(commentLink.githubCommentId)) {
        input.commentLinkStore.removeByGitHubCommentId(
          input.binding.id,
          commentLink.githubCommentId
        );
        deletedLinks.push(commentLink);
      }
    }

    for (const ghComment of githubComments) {
      const externalTaskId = formatIssueExternalId({
        owner: input.owner,
        repo: input.repo,
        issueNumber: itemLink.issueNumber,
      });

      const body = stripAttribution(ghComment.body);

      comments.push({
        externalId: String(ghComment.id),
        externalTaskId,
        body,
        author: ghComment.author,
        createdAt: ghComment.createdAt,
        updatedAt: ghComment.updatedAt,
        raw: ghComment,
      });

      const existingLink = input.commentLinkStore.getByGitHubCommentId(
        input.binding.id,
        ghComment.id
      );

      if (!existingLink) {
        const newLink: GitHubCommentLink = {
          bindingId: input.binding.id,
          taskId: itemLink.taskId,
          noteId: `external:${ghComment.id}` as NoteId,
          issueNumber: itemLink.issueNumber,
          githubCommentId: ghComment.id,
          lastMirroredAt: ghComment.updatedAt ?? ghComment.createdAt,
        };

        input.commentLinkStore.save(newLink);
        createdLinks.push(newLink);
      } else {
        const updatedLink: GitHubCommentLink = {
          ...existingLink,
          lastMirroredAt: ghComment.updatedAt ?? ghComment.createdAt,
        };

        input.commentLinkStore.save(updatedLink);
      }
    }
  }

  return { comments, createdLinks, deletedLinks };
}

export interface PushCommentsResult {
  commentLinks: SyncProviderPushCommentLink[];
  createdComments: GitHubComment[];
  updatedComments: GitHubComment[];
  deletedCommentIds: number[];
}

export async function pushComments(input: {
  binding: IntegrationBinding;
  owner: string;
  repo: string;
  tasks: TaskPushPayload[];
  issueClient: GitHubIssueClient;
  itemLinkStore: GitHubItemLinkStore;
  commentLinkStore: GitHubCommentLinkStore;
}): Promise<PushCommentsResult> {
  const commentLinks: SyncProviderPushCommentLink[] = [];
  const createdComments: GitHubComment[] = [];
  const updatedComments: GitHubComment[] = [];
  const deletedCommentIds: number[] = [];

  for (const task of input.tasks) {
    const itemLink = input.itemLinkStore.getByTaskId(input.binding.id, task.id);
    if (!itemLink) {
      continue;
    }

    const localTaskId = task.id;

    const existingCommentLinks = input.commentLinkStore.listByTask(input.binding.id, task.id);

    const currentNoteIds = new Set(task.comments.map((c) => c.id));

    for (const commentLink of existingCommentLinks) {
      if (!currentNoteIds.has(commentLink.noteId) && !isImportedCommentLink(commentLink)) {
        await deleteGitHubComment(input, commentLink, deletedCommentIds);
      }
    }

    for (const note of task.comments) {
      const existingLink = input.commentLinkStore.getByNoteId(input.binding.id, note.id);

      if (!existingLink && (hasGitHubAttribution(note.content) || hasImportedGitHubSyncTag(note))) {
        continue;
      }

      if (existingLink) {
        const updated = await updateGitHubCommentIfNeeded(
          input,
          note,
          existingLink,
          itemLink,
          updatedComments
        );
        commentLinks.push(
          createPushCommentLink(note.id, existingLink.githubCommentId, localTaskId, updated)
        );
      } else {
        const created = await createGitHubCommentFromNote(
          input,
          note,
          task,
          itemLink,
          createdComments
        );
        commentLinks.push(createPushCommentLink(note.id, created.id, localTaskId, created));
      }
    }
  }

  return { commentLinks, createdComments, updatedComments, deletedCommentIds };
}

async function deleteGitHubComment(
  input: {
    binding: IntegrationBinding;
    owner: string;
    repo: string;
    issueClient: GitHubIssueClient;
    commentLinkStore: GitHubCommentLinkStore;
  },
  commentLink: GitHubCommentLink,
  deletedCommentIds: number[]
): Promise<void> {
  try {
    await input.issueClient.deleteComment(
      { owner: input.owner, repo: input.repo },
      commentLink.githubCommentId
    );
  } catch {
    // Comment may already be deleted on GitHub; proceed with link cleanup
  }

  input.commentLinkStore.remove(input.binding.id, commentLink.noteId);
  deletedCommentIds.push(commentLink.githubCommentId);
}

async function updateGitHubCommentIfNeeded(
  input: {
    binding: IntegrationBinding;
    owner: string;
    repo: string;
    issueClient: GitHubIssueClient;
    commentLinkStore: GitHubCommentLinkStore;
  },
  note: Note,
  existingLink: GitHubCommentLink,
  _itemLink: GitHubItemLink,
  updatedComments: GitHubComment[]
): Promise<GitHubComment | null> {
  const noteUpdatedAt = Date.parse(note.createdAt);
  const lastMirroredAt = Date.parse(existingLink.lastMirroredAt);

  if (
    !Number.isNaN(noteUpdatedAt) &&
    !Number.isNaN(lastMirroredAt) &&
    noteUpdatedAt <= lastMirroredAt
  ) {
    return null;
  }

  const attributedBody = formatAttributedBody(
    formatToduAttribution(note.author, note.createdAt),
    note.content
  );

  const updated = await input.issueClient.updateComment(
    { owner: input.owner, repo: input.repo },
    existingLink.githubCommentId,
    attributedBody
  );

  updatedComments.push(updated);

  input.commentLinkStore.save({
    ...existingLink,
    lastMirroredAt: note.createdAt,
  });

  return updated;
}

async function createGitHubCommentFromNote(
  input: {
    binding: IntegrationBinding;
    owner: string;
    repo: string;
    issueClient: GitHubIssueClient;
    commentLinkStore: GitHubCommentLinkStore;
  },
  note: Note,
  task: TaskPushPayload,
  itemLink: GitHubItemLink,
  createdComments: GitHubComment[]
): Promise<GitHubComment> {
  const attributedBody = formatAttributedBody(
    formatToduAttribution(note.author, note.createdAt),
    note.content
  );

  const created = await input.issueClient.createComment(
    { owner: input.owner, repo: input.repo },
    itemLink.issueNumber,
    attributedBody
  );

  createdComments.push(created);

  const newLink: GitHubCommentLink = {
    bindingId: input.binding.id,
    taskId: task.id,
    noteId: note.id,
    issueNumber: itemLink.issueNumber,
    githubCommentId: created.id,
    lastMirroredAt: note.createdAt,
  };

  input.commentLinkStore.save(newLink);

  return created;
}

function createPushCommentLink(
  noteId: NoteId,
  githubCommentId: number,
  externalTaskId: string,
  comment: GitHubComment | null
): SyncProviderPushCommentLink {
  return {
    localNoteId: noteId,
    externalCommentId: String(githubCommentId),
    externalTaskId,
    sourceUrl: comment?.sourceUrl,
    createdAt: comment?.createdAt,
    updatedAt: comment?.updatedAt,
  };
}
