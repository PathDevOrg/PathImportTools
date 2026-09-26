import {
  acquireStorageLease,
  cleanupStaleDirectories,
  type EnumerableDirectoryHandle,
  removeEntryIfPresent,
  removeIfLeaseAvailable,
  staleStorageAgeMs,
  timestampFromName,
} from "@aura-importer/converter";

const outputDirectoryName = "aura-importer-output";
const releasedOutputRemovalDelayMs = 5 * 60 * 1000;

let cleanupPromise: Promise<void> | null = null;

export function scheduleReleasedOutputRemoval(name: string): void {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    return;
  }
  setTimeout(() => {
    void removeReleasedOutput(name).catch(() => undefined);
  }, releasedOutputRemovalDelayMs);
}

async function removeReleasedOutput(name: string): Promise<void> {
  const directory = await outputDirectory();
  if (directory) {
    await removeIfLeaseAvailable(`aura-importer-temp:output/${name}`, () =>
      removeEntryIfPresent(directory, name, false),
    );
  }
}

async function outputDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const root = await navigator.storage.getDirectory();
  try {
    return await root.getDirectoryHandle(outputDirectoryName);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return null;
    }
    throw error;
  }
}

export function cleanupStaleImporterStorage(now = Date.now()): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    return Promise.resolve();
  }
  cleanupPromise ??= cleanupStaleImporterStorageOnce(now).finally(() => {
    cleanupPromise = null;
  });
  return cleanupPromise;
}

export function acquireImporterStorageLease(key: string): Promise<() => Promise<void>> {
  return acquireStorageLease(`aura-importer-temp:${key}`);
}

async function cleanupStaleImporterStorageOnce(now: number): Promise<void> {
  await cleanupStaleDirectories("aura-importer-evidence-", "aura-importer-temp:evidence/", now);
  await cleanupStaleDirectories("aura-importer-", "aura-importer-temp:pool/", now);
  await cleanupOutputDirectory(now);
}

async function cleanupOutputDirectory(now: number): Promise<void> {
  const directory = await outputDirectory();
  if (!directory) {
    return;
  }
  const cutoff = now - staleStorageAgeMs;
  for await (const [name] of (directory as EnumerableDirectoryHandle).entries()) {
    const timestamp = timestampFromName(name);
    if (timestamp !== null && timestamp < cutoff) {
      await removeIfLeaseAvailable(`aura-importer-temp:output/${name}`, () =>
        removeEntryIfPresent(directory, name, true),
      );
    }
  }
}
