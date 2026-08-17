import { convertImportFileHandles, scanImportEntries } from "@aura-importer/converter";
import { type AuraDatabaseWriter, createAuraDatabaseWriter } from "./database";
import { buildImportHandles } from "./importSources";
import { makeImportFilename } from "./outputFilename";
import type { WorkerProgress, WorkerRequest, WorkerResponse } from "./workerTypes";

const bufferedInputByteLimit = 256 * 1024 * 1024;
const pendingOutputReleases = new Map<string, () => Promise<void>>();
const activeControllers = new Map<string, AbortController>();

const post = (response: WorkerResponse, transfer?: Transferable[]): void => {
  self.postMessage(response, { transfer });
};

const postProgress = (id: string, progress: WorkerProgress): void => {
  post({ id, type: "progress", message: progress.message, progress });
};

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  void handleRequest(event.data);
});

async function handleRequest(request: WorkerRequest): Promise<void> {
  if (request.type === "release-output") {
    const release = pendingOutputReleases.get(request.outputToken);
    pendingOutputReleases.delete(request.outputToken);
    try {
      await release?.();
    } catch {
      void 0;
    }
    return;
  }
  if (request.type === "cancel") {
    activeControllers.get(request.requestId)?.abort();
    return;
  }

  for (const [activeId, controller] of activeControllers) {
    if (activeId !== request.id) {
      controller.abort();
    }
  }
  const controller = new AbortController();
  activeControllers.set(request.id, controller);

  let writer: AuraDatabaseWriter | null = null;
  try {
    postProgress(request.id, {
      phase: "index",
      message: "Indexing selected files",
      completed: 0,
      total: request.files.length,
    });
    const entries = await buildImportHandles(
      request.files,
      (progress) => {
        postProgress(request.id, { phase: "index", ...progress });
      },
      { signal: controller.signal },
    );

    if (request.type === "scan") {
      const scan = await scanImportEntries(entries, {
        signal: controller.signal,
        onProgress: (progress) => postProgress(request.id, progress),
      });
      post({ id: request.id, type: "scan-complete", scan });
      return;
    }

    const inputBytes = entries
      .filter((entry) => {
        const path = entry.path.toLowerCase();
        return path.endsWith(".json") || path.endsWith(".json.gz");
      })
      .reduce((sum, entry) => sum + entry.size, 0);
    postProgress(request.id, {
      phase: "schema",
      message: "Creating Path import database",
      completed: 0,
      total: 1,
    });
    writer = await createAuraDatabaseWriter(
      (message) => {
        postProgress(request.id, message);
      },
      request.output ?? { filename: makeImportFilename() },
      { signal: controller.signal },
    );
    if (writer.outputMode === "buffered" && inputBytes > bufferedInputByteLimit) {
      throw new Error(
        "This history is too large for this browser's buffered download. Use a current desktop browser with disk-backed OPFS or direct file saving, or select a smaller archive.",
      );
    }
    const result = await convertImportFileHandles(entries, {
      signal: controller.signal,
      onProgress: (progress) => postProgress(request.id, progress),
      onRows: (table, rows) => writer?.writeRows(table, rows),
    });
    const output = await writer.finish(result);
    writer = null;
    if (controller.signal.aborted) {
      await output.release?.();
      return;
    }
    const outputToken = output.release ? crypto.randomUUID() : undefined;
    if (outputToken && output.release) {
      pendingOutputReleases.set(outputToken, output.release);
    }

    const response: WorkerResponse = {
      id: request.id,
      type: "convert-complete",
      filename: output.filename,
      savedToDisk: output.savedToDisk,
      diagnostics: result.report.diagnostics,
      bytes: output.bytes,
      file: output.file,
      outputToken,
    };
    try {
      if (output.bytes) {
        post(response, [output.bytes.buffer]);
      } else {
        post(response);
      }
    } catch (error) {
      if (outputToken) {
        pendingOutputReleases.delete(outputToken);
        await output.release?.();
      }
      throw error;
    }
  } catch (error) {
    try {
      await writer?.abort();
    } catch {
      void 0;
    }
    if (controller.signal.aborted) {
      return;
    }
    post({
      id: request.id,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    activeControllers.delete(request.id);
  }
}
