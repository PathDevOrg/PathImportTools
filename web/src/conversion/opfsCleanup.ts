const staleStorageAgeMs = 24 * 60 * 60 * 1000;

type EnumerableDirectoryHandle = FileSystemDirectoryHandle & {
  entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

interface LockManagerLike {
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown | null) => Promise<T>): Promise<T>;
  request<T>(name: string, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

let cleanupPromise: Promise<void> | null = null;

export function cleanupStaleImporterStorage(now = Date.now()): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    return Promise.resolve();
  }
  cleanupPromise ??= cleanupStaleImporterStorageOnce(now).finally(() => {
    cleanupPromise = null;
  });
  return cleanupPromise;
}

export async function acquireImporterStorageLease(key: string): Promise<() => Promise<void>> {
  if (typeof navigator === "undefined") {
    return async () => undefined;
  }
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  if (!locks) {
    return async () => undefined;
  }
  let release: (() => void) | null = null;
  let acquired: (() => void) | null = null;
  const acquiredPromise = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const held = locks.request(`aura-importer-temp:${key}`, async () => {
    acquired?.();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await acquiredPromise;
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

async function cleanupStaleImporterStorageOnce(now: number): Promise<void> {
  const root = await navigator.storage.getDirectory() as EnumerableDirectoryHandle;
  const cutoff = now - staleStorageAgeMs;
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === "directory" && isCleanupCandidate(name, "aura-importer-evidence-", cutoff)) {
      await removeIfLeaseAvailable(`evidence/${name}`, () => removeEntryIfPresent(root, name, true));
    } else if (handle.kind === "directory" && isCleanupCandidate(name, "aura-importer-", cutoff)) {
      await removeIfLeaseAvailable(`pool/${name}`, () => removeEntryIfPresent(root, name, true));
    } else if (handle.kind === "directory" && name === "aura-importer-output") {
      await cleanupOutputDirectory(handle as EnumerableDirectoryHandle, cutoff);
    }
  }
}

async function cleanupOutputDirectory(directory: EnumerableDirectoryHandle, cutoff: number): Promise<void> {
  for await (const [name] of directory.entries()) {
    const timestamp = timestampFromName(name);
    if (timestamp !== null && timestamp < cutoff) {
      await removeIfLeaseAvailable(`output/${name}`, () => removeEntryIfPresent(directory, name, true));
    }
  }
}

function isCleanupCandidate(name: string, prefix: string, cutoff: number): boolean {
  if (!name.startsWith(prefix)) {
    return false;
  }
  const timestamp = timestampFromName(name.slice(prefix.length));
  return timestamp !== null && (hasWebLocks() || timestamp < cutoff);
}

function hasWebLocks(): boolean {
  return Boolean((navigator as Navigator & { locks?: LockManagerLike }).locks);
}

async function removeIfLeaseAvailable(key: string, remove: () => Promise<void>): Promise<void> {
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  if (!locks) {
    await remove();
    return;
  }
  await locks.request(`aura-importer-temp:${key}`, { ifAvailable: true }, async (lock) => {
    if (lock) {
      await remove();
    }
  });
}

function timestampFromName(name: string): number | null {
  const match = /^(\d{13})(?:-|$)/.exec(name);
  return match ? Number(match[1]) : null;
}

async function removeEntryIfPresent(
  directory: FileSystemDirectoryHandle,
  name: string,
  recursive: boolean
): Promise<void> {
  try {
    await directory.removeEntry(name, { recursive });
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
      throw error;
    }
  }
}
