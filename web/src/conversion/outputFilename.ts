export function makeImportFilename(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `path-import-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.db`;
}

export async function makeUniqueImportFilename(directory: FileSystemDirectoryHandle, preferred: string): Promise<string> {
  const extensionIndex = preferred.lastIndexOf(".");
  const stem = extensionIndex > 0 ? preferred.slice(0, extensionIndex) : preferred;
  const extension = extensionIndex > 0 ? preferred.slice(extensionIndex) : "";
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? preferred : `${stem}-${suffix}${extension}`;
    try {
      await directory.getFileHandle(candidate);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        return candidate;
      }
      throw error;
    }
  }
}
