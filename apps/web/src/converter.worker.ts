import { convertImportFileHandles, scanImportEntries } from "@aura-importer/converter";
import { createAuraDatabaseOutput } from "./database";
import { buildImportHandles } from "./importSources";
import { makeImportFilename } from "./outputFilename";
import { schemaMigrations } from "./schemaMigrations";
import type { WorkerProgress, WorkerRequest, WorkerResponse } from "./workerTypes";

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
  try {
    postProgress(request.id, {
      phase: "index",
      message: "Indexing selected files",
      completed: 0,
      total: request.files.length,
      bytesCompleted: 0,
      bytesTotal: request.files.reduce((sum, payload) => sum + payload.file.size, 0)
    });
    const entries = await buildImportHandles(request.files, (progress) => {
      postProgress(request.id, { phase: "index", ...progress });
    });

    if (request.type === "scan") {
      const scan = await scanImportEntries(entries);
      post({ id: request.id, type: "scan-complete", scan });
      return;
    }

    postProgress(request.id, {
      phase: "parse",
      message: "Converting timeline data",
      completed: 0,
      total: entries.filter((entry) => entry.path.endsWith(".json") || entry.path.endsWith(".json.gz")).length
    });
    const result = await convertImportFileHandles(entries, {
      onProgress: (progress) => postProgress(request.id, progress)
    });
    postProgress(request.id, {
      phase: "schema",
      message: "Creating Path import database",
      completed: 0,
      total: schemaMigrations.length
    });
    const output = await createAuraDatabaseOutput(result, schemaMigrations, (message) => {
      postProgress(request.id, message);
    }, request.output ?? { filename: makeImportFilename() });

    const response: WorkerResponse = {
      id: request.id,
      type: "convert-complete",
      report: result.report,
      filename: output.filename,
      size: output.size,
      savedToDisk: output.savedToDisk,
      bytes: output.bytes
    };
    if (output.bytes) {
      post(response, [output.bytes.buffer]);
    } else {
      post(response);
    }
  } catch (error) {
    post({
      id: request.id,
      type: "error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
