export const staleStorageAgeMs = 24 * 60 * 60 * 1000;

export type EnumerableDirectoryHandle = FileSystemDirectoryHandle & {
  entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

interface LockManagerLike {
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown | null) => Promise<T>): Promise<T>;
  request<T>(name: string, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

function webLocks(): LockManagerLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  return (navigator as Navigator & { locks?: LockManagerLike }).locks ?? null;
}

export async function acquireStorageLease(lockName: string): Promise<() => Promise<void>> {
  const locks = webLocks();
  if (!locks) {
    return async () => undefined;
  }
  let release: (() => void) | null = null;
  let acquired: (() => void) | null = null;
  let requestFailed = false;
  const acquiredPromise = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const held = locks
    .request(lockName, async () => {
      acquired?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    })
    .catch(() => {
      requestFailed = true;
      acquired?.();
    });
  await Promise.race([acquiredPromise, held]);
  if (requestFailed) {
    return async () => undefined;
  }
  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    release?.();
    await held;
  };
}

export async function cleanupStaleDirectories(prefix: string, lockPrefix: string, now = Date.now()): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    return;
  }
  const root = (await navigator.storage.getDirectory()) as EnumerableDirectoryHandle;
  const cutoff = now - staleStorageAgeMs;
  const hasLocks = Boolean(webLocks());
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== "directory" || !isCleanupCandidate(name, prefix, cutoff, hasLocks)) {
      continue;
    }
    await removeIfLeaseAvailable(`${lockPrefix}${name}`, () => removeEntryIfPresent(root, name, true));
  }
}

export async function removeIfLeaseAvailable(lockName: string, remove: () => Promise<void>): Promise<void> {
  const locks = webLocks();
  if (!locks) {
    await remove();
    return;
  }
  await locks.request(lockName, { ifAvailable: true }, async (lock) => {
    if (lock) {
      await remove();
    }
  });
}

export async function removeEntryIfPresent(
  directory: FileSystemDirectoryHandle,
  name: string,
  recursive: boolean,
): Promise<void> {
  try {
    await directory.removeEntry(name, { recursive });
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
      throw error;
    }
  }
}

export function timestampFromName(name: string): number | null {
  const match = /^(\d{13})(?:-|$)/.exec(name);
  return match ? Number(match[1]) : null;
}

function isCleanupCandidate(name: string, prefix: string, cutoff: number, hasLocks: boolean): boolean {
  if (!name.startsWith(prefix)) {
    return false;
  }
  const timestamp = timestampFromName(name.slice(prefix.length));
  return timestamp !== null && (hasLocks || timestamp < cutoff);
}
