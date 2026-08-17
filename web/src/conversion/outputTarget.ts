import type { WorkerOutputTarget } from "./workerTypes";

export type SaveFilePickerHost = {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FileSystemFileHandle>;
};

export async function makeWorkerOutputTarget(
  host: SaveFilePickerHost,
  filename: string,
): Promise<WorkerOutputTarget | null> {
  if (!host.showSaveFilePicker) {
    return { filename };
  }

  try {
    const saveHandle = await host.showSaveFilePicker({
      suggestedName: filename,
      types: [
        {
          description: "SQLite database",
          accept: {
            "application/vnd.sqlite3": [".db"],
          },
        },
      ],
    });
    return { filename: saveHandle.name || filename, saveHandle };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return null;
    }
    if (error instanceof DOMException && (error.name === "SecurityError" || error.name === "NotAllowedError")) {
      return { filename };
    }
    throw error;
  }
}
