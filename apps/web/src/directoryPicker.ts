export type PickedDirectoryFile = {
  path: string;
  file: File;
};

export type DirectoryPickerHost = {
  showDirectoryPicker?: (options?: { mode?: "read" }) => Promise<FileSystemDirectoryHandle>;
};

type IterableFileSystemHandle = FileSystemFileHandle | IterableDirectoryHandle;

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries: () => AsyncIterableIterator<[string, IterableFileSystemHandle]>;
};

export async function pickDirectoryFiles(host: DirectoryPickerHost): Promise<PickedDirectoryFile[] | null> {
  if (!host.showDirectoryPicker) {
    return null;
  }

  try {
    const directory = await host.showDirectoryPicker({ mode: "read" });
    return readDirectoryFiles(directory, directory.name);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return [];
    }
    throw error;
  }
}

async function readDirectoryFiles(directory: FileSystemDirectoryHandle, parentPath: string): Promise<PickedDirectoryFile[]> {
  const files: PickedDirectoryFile[] = [];
  const iterableDirectory = directory as IterableDirectoryHandle;
  for await (const [name, handle] of iterableDirectory.entries()) {
    const path = `${parentPath}/${name}`;
    if (handle.kind === "file") {
      files.push({ path, file: await handle.getFile() });
    } else {
      files.push(...await readDirectoryFiles(handle, path));
    }
  }
  return files;
}
