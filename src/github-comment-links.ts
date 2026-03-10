import fs from "node:fs";
import path from "node:path";

import type { IntegrationBinding, NoteId } from "@todu/core";

import type { Task } from "@todu/core";

export interface GitHubCommentLink {
  bindingId: IntegrationBinding["id"];
  taskId: Task["id"];
  noteId: NoteId;
  issueNumber: number;
  githubCommentId: number;
  lastMirroredAt: string;
}

export interface GitHubCommentLinkStore {
  getByNoteId(bindingId: IntegrationBinding["id"], noteId: NoteId): GitHubCommentLink | null;
  getByGitHubCommentId(
    bindingId: IntegrationBinding["id"],
    githubCommentId: number
  ): GitHubCommentLink | null;
  listByIssue(bindingId: IntegrationBinding["id"], issueNumber: number): GitHubCommentLink[];
  listByTask(bindingId: IntegrationBinding["id"], taskId: Task["id"]): GitHubCommentLink[];
  listAll(): GitHubCommentLink[];
  save(link: GitHubCommentLink): void;
  remove(bindingId: IntegrationBinding["id"], noteId: NoteId): void;
  removeByGitHubCommentId(bindingId: IntegrationBinding["id"], githubCommentId: number): void;
}

export function createInMemoryGitHubCommentLinkStore(): GitHubCommentLinkStore {
  const links = new Map<string, GitHubCommentLink>();

  const getNoteKey = (bindingId: IntegrationBinding["id"], noteId: NoteId): string =>
    `note:${bindingId}:${noteId}`;
  const getGitHubKey = (bindingId: IntegrationBinding["id"], githubCommentId: number): string =>
    `gh:${bindingId}:${githubCommentId}`;

  return {
    getByNoteId(bindingId, noteId): GitHubCommentLink | null {
      return links.get(getNoteKey(bindingId, noteId)) ?? null;
    },
    getByGitHubCommentId(bindingId, githubCommentId): GitHubCommentLink | null {
      return links.get(getGitHubKey(bindingId, githubCommentId)) ?? null;
    },
    listByIssue(bindingId, issueNumber): GitHubCommentLink[] {
      const result: GitHubCommentLink[] = [];
      const seen = new Set<string>();
      for (const link of links.values()) {
        if (
          link.bindingId === bindingId &&
          link.issueNumber === issueNumber &&
          !seen.has(link.noteId)
        ) {
          seen.add(link.noteId);
          result.push(link);
        }
      }

      return result;
    },
    listByTask(bindingId, taskId): GitHubCommentLink[] {
      const result: GitHubCommentLink[] = [];
      const seen = new Set<string>();
      for (const link of links.values()) {
        if (link.bindingId === bindingId && link.taskId === taskId && !seen.has(link.noteId)) {
          seen.add(link.noteId);
          result.push(link);
        }
      }

      return result;
    },
    listAll(): GitHubCommentLink[] {
      const allLinks = new Map<string, GitHubCommentLink>();
      for (const link of links.values()) {
        allLinks.set(`${link.bindingId}:${link.noteId}`, link);
      }

      return [...allLinks.values()];
    },
    save(link): void {
      links.set(getNoteKey(link.bindingId, link.noteId), link);
      links.set(getGitHubKey(link.bindingId, link.githubCommentId), link);
    },
    remove(bindingId, noteId): void {
      const link = links.get(getNoteKey(bindingId, noteId));
      if (link) {
        links.delete(getNoteKey(bindingId, noteId));
        links.delete(getGitHubKey(bindingId, link.githubCommentId));
      }
    },
    removeByGitHubCommentId(bindingId, githubCommentId): void {
      const link = links.get(getGitHubKey(bindingId, githubCommentId));
      if (link) {
        links.delete(getNoteKey(bindingId, link.noteId));
        links.delete(getGitHubKey(bindingId, githubCommentId));
      }
    },
  };
}

export function createFileGitHubCommentLinkStore(storagePath: string): GitHubCommentLinkStore {
  const readLinks = (): GitHubCommentLink[] => {
    if (!fs.existsSync(storagePath)) {
      return [];
    }

    const rawContent = fs.readFileSync(storagePath, "utf8");
    if (!rawContent.trim()) {
      return [];
    }

    const parsedContent = JSON.parse(rawContent) as unknown;
    if (!Array.isArray(parsedContent)) {
      throw new Error(`Invalid GitHub comment link store at ${storagePath}: expected JSON array`);
    }

    return parsedContent.map((link) => {
      if (!link || typeof link !== "object") {
        throw new Error(`Invalid GitHub comment link store at ${storagePath}: invalid link record`);
      }

      return link as GitHubCommentLink;
    });
  };

  const writeLinks = (links: GitHubCommentLink[]): void => {
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, `${JSON.stringify(links, null, 2)}\n`, "utf8");
  };

  return {
    getByNoteId(bindingId, noteId): GitHubCommentLink | null {
      return (
        readLinks().find((link) => link.bindingId === bindingId && link.noteId === noteId) ?? null
      );
    },
    getByGitHubCommentId(bindingId, githubCommentId): GitHubCommentLink | null {
      return (
        readLinks().find(
          (link) => link.bindingId === bindingId && link.githubCommentId === githubCommentId
        ) ?? null
      );
    },
    listByIssue(bindingId, issueNumber): GitHubCommentLink[] {
      return readLinks().filter(
        (link) => link.bindingId === bindingId && link.issueNumber === issueNumber
      );
    },
    listByTask(bindingId, taskId): GitHubCommentLink[] {
      return readLinks().filter((link) => link.bindingId === bindingId && link.taskId === taskId);
    },
    listAll(): GitHubCommentLink[] {
      return readLinks();
    },
    save(link): void {
      const existing = readLinks().filter(
        (existingLink) =>
          !(
            existingLink.bindingId === link.bindingId &&
            (existingLink.noteId === link.noteId ||
              existingLink.githubCommentId === link.githubCommentId)
          )
      );

      existing.push(link);
      writeLinks(existing);
    },
    remove(bindingId, noteId): void {
      const existing = readLinks().filter(
        (link) => !(link.bindingId === bindingId && link.noteId === noteId)
      );

      writeLinks(existing);
    },
    removeByGitHubCommentId(bindingId, githubCommentId): void {
      const existing = readLinks().filter(
        (link) => !(link.bindingId === bindingId && link.githubCommentId === githubCommentId)
      );

      writeLinks(existing);
    },
  };
}
