export interface WriteRecord {
  key: string;
  timestamp: string;
}

export interface LoopPreventionStore {
  recordWrite(key: string, timestamp: string): void;
  isOwnWrite(key: string, timestamp: string): boolean;
  clearExpired(maxAgeMs: number, now?: Date): void;
  listAll(): WriteRecord[];
}

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

export function createLoopPreventionStore(): LoopPreventionStore {
  const writes = new Map<string, string>();

  return {
    recordWrite(key, timestamp): void {
      writes.set(key, timestamp);
    },
    isOwnWrite(key, timestamp): boolean {
      const recorded = writes.get(key);
      if (!recorded) {
        return false;
      }

      return recorded === timestamp;
    },
    clearExpired(maxAgeMs: number = DEFAULT_MAX_AGE_MS, now: Date = new Date()): void {
      const cutoff = now.getTime() - maxAgeMs;

      for (const [key, timestamp] of writes.entries()) {
        const recordedTime = Date.parse(timestamp);
        if (!Number.isNaN(recordedTime) && recordedTime < cutoff) {
          writes.delete(key);
        }
      }
    },
    listAll(): WriteRecord[] {
      const records: WriteRecord[] = [];
      for (const [key, timestamp] of writes.entries()) {
        records.push({ key, timestamp });
      }

      return records;
    },
  };
}

export function createWriteKey(
  entityType: "issue" | "comment",
  bindingId: string,
  identifier: string
): string {
  return `${entityType}:${bindingId}:${identifier}`;
}
