export type PickedDirectoryFile = {
  path: string;
  file: File;
};

export type PickedDirectorySelection = {
  files: PickedDirectoryFile[];
  directory: FileSystemDirectoryHandle | null;
  filename: string;
};

export type DirectoryPickerHost = {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};

type IterableFileSystemHandle = FileSystemFileHandle | IterableDirectoryHandle;

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries: () => AsyncIterableIterator<[string, IterableFileSystemHandle]>;
};

export async function pickDirectoryFiles(host: DirectoryPickerHost, filename: string): Promise<PickedDirectorySelection | null> {
  if (!host.showDirectoryPicker) {
    return null;
  }

  try {
    const directory = await host.showDirectoryPicker({ mode: "readwrite" });
    return { files: await readDirectoryFiles(directory, directory.name), directory, filename };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { files: [], directory: null, filename };
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
