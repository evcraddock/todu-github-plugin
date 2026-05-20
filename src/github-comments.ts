import type {
  ExportedCommentInput,
  ExportedTaskInput,
  ImportedCommentInput,
  IntegrationBinding,
  Note,
  NoteId,
  SyncProviderPushCommentLink,
} from "@todu/core";

import type { GitHubComment, GitHubIssueClient } from "@/github-client";
import type { GitHubCommentLink, GitHubCommentLinkStore } from "@/github-comment-links";
import { mapGitHubUserToExternalActorRef } from "@/github-fields";
import { formatIssueExternalId } from "@/github-ids";
import type { GitHubItemLink, GitHubItemLinkStore } from "@/github-links";

const GITHUB_ATTRIBUTION_PREFIX = "_Synced from GitHub comment by @";
const TODU_ATTRIBUTION_PREFIX = "_Synced from todu comment by @";
const ATTRIBUTION_SUFFIX_PATTERN = / on \d{4}-\d{2}-\d{2}T[\d:.]+Z_$/;
const SYNC_EXTERNAL_ID_TAG_PREFIX = "sync:externalId:";

function getDisplayAuthor(author: { login?: string; displayName?: string } | string): string {
  if (typeof author === "string") {
    return author;
  }

  return author.login ?? author.displayName ?? "unknown";
}

export function formatGitHubAttribution(
  author: { login?: string; displayName?: string } | string,
  timestamp: string
): string {
  return `_Synced from GitHub comment by @${getDisplayAuthor(author)} on ${timestamp}_`;
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

function getSyncExternalCommentIdFromTags(tags: unknown): number | null {
  if (!Array.isArray(tags)) {
    return null;
  }

  for (const tag of tags) {
    if (typeof tag !== "string" || !tag.startsWith(SYNC_EXTERNAL_ID_TAG_PREFIX)) {
      continue;
    }

    const externalId = Number.parseInt(tag.slice(SYNC_EXTERNAL_ID_TAG_PREFIX.length), 10);
    if (Number.isInteger(externalId) && externalId > 0) {
      return externalId;
    }
  }

  return null;
}

function hasImportedGitHubSyncTag(note: Note): boolean {
  return getSyncExternalCommentIdFromTags(note.tags) !== null;
}

export interface PullCommentsResult {
  comments: ImportedCommentInput[];
  createdLinks: GitHubCommentLink[];
}

export async function pullComments(input: {
  binding: IntegrationBinding;
  owner: string;
  repo: string;
  issueClient: GitHubIssueClient;
  itemLinkStore: GitHubItemLinkStore;
  commentLinkStore: GitHubCommentLinkStore;
  issueNumbers?: readonly number[];
  since?: string;
}): Promise<PullCommentsResult> {
  const comments: ImportedCommentInput[] = [];
  const createdLinks: GitHubCommentLink[] = [];

  const issueNumbers = input.issueNumbers ? new Set(input.issueNumbers) : null;
  const itemLinks = input.itemLinkStore
    .list(input.binding.id)
    .filter((itemLink) => issueNumbers?.has(itemLink.issueNumber) ?? true);

  for (const itemLink of itemLinks) {
    const githubComments = await input.issueClient.listComments(
      { owner: input.owner, repo: input.repo },
      itemLink.issueNumber,
      input.since ? { since: input.since } : undefined
    );

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
        author: mapGitHubUserToExternalActorRef(ghComment.author),
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

  return { comments, createdLinks };
}

export interface PushCommentsResult {
  commentLinks: SyncProviderPushCommentLink[];
  createdComments: GitHubComment[];
  updatedComments: GitHubComment[];
}

function resolveCommentLinkForPush(input: {
  binding: IntegrationBinding;
  taskId: ExportedTaskInput["localTaskId"];
  itemLink: GitHubItemLink;
  comment: ExportedCommentInput;
  commentLinkStore: GitHubCommentLinkStore;
}): GitHubCommentLink | null {
  const existingLink = input.commentLinkStore.getByNoteId(
    input.binding.id,
    input.comment.localNoteId
  );
  const syncExternalCommentId = getSyncExternalCommentIdFromTags(
    (input.comment as { tags?: unknown }).tags
  );

  if (syncExternalCommentId === null) {
    return existingLink;
  }

  const canonicalLink = input.commentLinkStore.getByGitHubCommentId(
    input.binding.id,
    syncExternalCommentId
  );
  const reconciledLink: GitHubCommentLink = {
    bindingId: input.binding.id,
    taskId: input.taskId,
    noteId: input.comment.localNoteId,
    issueNumber: input.itemLink.issueNumber,
    githubCommentId: syncExternalCommentId,
    lastMirroredAt:
      canonicalLink?.lastMirroredAt ??
      existingLink?.lastMirroredAt ??
      input.comment.updatedAt ??
      input.comment.createdAt,
  };

  if (existingLink && existingLink.githubCommentId !== syncExternalCommentId) {
    input.commentLinkStore.remove(input.binding.id, input.comment.localNoteId);
  }

  if (
    canonicalLink?.noteId !== input.comment.localNoteId ||
    canonicalLink?.taskId !== input.taskId ||
    canonicalLink?.issueNumber !== input.itemLink.issueNumber ||
    existingLink?.githubCommentId !== syncExternalCommentId
  ) {
    input.commentLinkStore.save(reconciledLink);
  }

  return canonicalLink?.noteId === input.comment.localNoteId ? canonicalLink : reconciledLink;
}

export async function pushComments(input: {
  binding: IntegrationBinding;
  owner: string;
  repo: string;
  tasks: ExportedTaskInput[];
  issueClient: GitHubIssueClient;
  itemLinkStore: GitHubItemLinkStore;
  commentLinkStore: GitHubCommentLinkStore;
  loadTaskNotes?: (
    taskId: ExportedTaskInput["localTaskId"]
  ) => Promise<Array<{ id: string; tags: string[] }>>;
  onStaleLink?: (context: {
    itemLink: GitHubItemLink;
    commentLink: GitHubCommentLink;
  }) => void | Promise<void>;
}): Promise<PushCommentsResult> {
  const commentLinks: SyncProviderPushCommentLink[] = [];
  const createdComments: GitHubComment[] = [];
  const updatedComments: GitHubComment[] = [];

  for (const task of input.tasks) {
    const itemLink = input.itemLinkStore.getByTaskId(input.binding.id, task.localTaskId);
    if (!itemLink) {
      continue;
    }

    const externalTaskId = String(task.localTaskId);
    const currentNoteIds = new Set(task.comments.map((comment) => String(comment.localNoteId)));
    const existingCommentLinks = input.commentLinkStore.listByIssue(
      input.binding.id,
      itemLink.issueNumber
    );
    let noteTagsById: Map<string, string[]> | null = null;
    const loadNoteTagsForTask = async (): Promise<Map<string, string[]>> => {
      if (noteTagsById) {
        return noteTagsById;
      }

      const taskNotes = input.loadTaskNotes ? await input.loadTaskNotes(task.localTaskId) : [];
      noteTagsById = new Map(taskNotes.map((note) => [String(note.id), note.tags]));
      return noteTagsById;
    };

    for (const existingCommentLink of existingCommentLinks) {
      if (currentNoteIds.has(String(existingCommentLink.noteId))) {
        continue;
      }

      input.commentLinkStore.remove(input.binding.id, existingCommentLink.noteId);
      await input.onStaleLink?.({ itemLink, commentLink: existingCommentLink });
    }

    for (const comment of task.comments) {
      const commentTags = (comment as { tags?: unknown }).tags;
      const shouldLoadTags = shouldLoadNoteTagsForComment({
        comment,
        commentTags,
        existingCommentLinks,
      });
      const loadedTags = shouldLoadTags
        ? (await loadNoteTagsForTask()).get(String(comment.localNoteId))
        : undefined;
      const commentWithTags = {
        ...comment,
        tags: loadedTags ?? commentTags,
      };
      const existingLink = resolveCommentLinkForPush({
        binding: input.binding,
        taskId: task.localTaskId,
        itemLink,
        comment: commentWithTags,
        commentLinkStore: input.commentLinkStore,
      });

      const hasImportedSyncTag =
        getSyncExternalCommentIdFromTags((commentWithTags as { tags?: unknown }).tags) !== null;

      if (!existingLink && (hasGitHubAttribution(comment.body) || hasImportedSyncTag)) {
        continue;
      }

      if (existingLink) {
        const updated = await updateGitHubCommentIfNeeded(
          input,
          comment,
          existingLink,
          updatedComments
        );
        commentLinks.push(
          createPushCommentLink(
            comment.localNoteId,
            existingLink.githubCommentId,
            externalTaskId,
            updated
          )
        );
      } else {
        const created = await createGitHubCommentFromExport(
          input,
          comment,
          task,
          itemLink,
          createdComments
        );
        commentLinks.push(
          createPushCommentLink(comment.localNoteId, created.id, externalTaskId, created)
        );
      }
    }
  }

  return { commentLinks, createdComments, updatedComments };
}

function shouldLoadNoteTagsForComment(input: {
  comment: ExportedCommentInput;
  commentTags: unknown;
  existingCommentLinks: GitHubCommentLink[];
}): boolean {
  if (getSyncExternalCommentIdFromTags(input.commentTags) !== null) {
    return false;
  }

  const existingLink = input.existingCommentLinks.find(
    (link) => link.noteId === input.comment.localNoteId
  );
  if (!existingLink) {
    return true;
  }

  return input.existingCommentLinks.some(
    (link) =>
      link.noteId !== input.comment.localNoteId && String(link.noteId).startsWith("external:")
  );
}

async function updateGitHubCommentIfNeeded(
  input: {
    binding: IntegrationBinding;
    owner: string;
    repo: string;
    issueClient: GitHubIssueClient;
    commentLinkStore: GitHubCommentLinkStore;
  },
  comment: ExportedCommentInput,
  existingLink: GitHubCommentLink,
  updatedComments: GitHubComment[]
): Promise<GitHubComment | null> {
  const commentUpdatedAt = Date.parse(comment.updatedAt ?? comment.createdAt);
  const lastMirroredAt = Date.parse(existingLink.lastMirroredAt);

  if (
    !Number.isNaN(commentUpdatedAt) &&
    !Number.isNaN(lastMirroredAt) &&
    commentUpdatedAt <= lastMirroredAt
  ) {
    return null;
  }

  const attributedBody = formatAttributedBody(
    formatToduAttribution("todu", comment.createdAt),
    comment.body
  );

  const updated = await input.issueClient.updateComment(
    { owner: input.owner, repo: input.repo },
    existingLink.githubCommentId,
    attributedBody
  );

  updatedComments.push(updated);

  input.commentLinkStore.save({
    ...existingLink,
    lastMirroredAt: comment.updatedAt ?? comment.createdAt,
  });

  return updated;
}

async function createGitHubCommentFromExport(
  input: {
    binding: IntegrationBinding;
    owner: string;
    repo: string;
    issueClient: GitHubIssueClient;
    commentLinkStore: GitHubCommentLinkStore;
  },
  comment: ExportedCommentInput,
  task: ExportedTaskInput,
  itemLink: GitHubItemLink,
  createdComments: GitHubComment[]
): Promise<GitHubComment> {
  const attributedBody = formatAttributedBody(
    formatToduAttribution("todu", comment.createdAt),
    comment.body
  );

  const created = await input.issueClient.createComment(
    { owner: input.owner, repo: input.repo },
    itemLink.issueNumber,
    attributedBody
  );

  createdComments.push(created);

  const newLink: GitHubCommentLink = {
    bindingId: input.binding.id,
    taskId: task.localTaskId,
    noteId: comment.localNoteId,
    issueNumber: itemLink.issueNumber,
    githubCommentId: created.id,
    lastMirroredAt: comment.updatedAt ?? comment.createdAt,
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

export function shouldSkipImportedGitHubNote(note: Note): boolean {
  return hasGitHubAttribution(note.content) || hasImportedGitHubSyncTag(note);
}
