import { convertImportFileHandles, scanImportEntries } from "@aura-importer/converter";
import { createAuraDatabaseWriter, type AuraDatabaseWriter } from "./database";
import { buildImportHandles } from "./importSources";
import { makeImportFilename } from "./outputFilename";
import type { WorkerProgress, WorkerRequest, WorkerResponse } from "./workerTypes";

const bufferedInputByteLimit = 256 * 1024 * 1024;
const pendingOutputReleases = new Map<string, () => Promise<void>>();

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
      // Startup cleanup will recover importer-owned OPFS files after interrupted releases.
    }
    return;
  }
  let writer: AuraDatabaseWriter | null = null;
  try {
    postProgress(request.id, {
      phase: "index",
      message: "Indexing selected files",
      completed: 0,
      total: request.files.length
    });
    const entries = await buildImportHandles(request.files, (progress) => {
      postProgress(request.id, { phase: "index", ...progress });
    });

    if (request.type === "scan") {
      const scan = await scanImportEntries(entries);
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
      total: 1
    });
    writer = await createAuraDatabaseWriter((message) => {
      postProgress(request.id, message);
    }, request.output ?? { filename: makeImportFilename() });
    if (writer.outputMode === "buffered" && inputBytes > bufferedInputByteLimit) {
      throw new Error("This history is too large for this browser's buffered download. Use a current desktop browser with disk-backed OPFS or direct file saving, or select a smaller archive.");
    }
    const result = await convertImportFileHandles(entries, {
      onProgress: (progress) => postProgress(request.id, progress),
      onRows: (table, rows) => writer?.writeRows(table, rows)
    });
    const output = await writer.finish(result);
    writer = null;
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
      outputToken
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
    writer?.abort();
    post({
      id: request.id,
      type: "error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
