import { convertImportFileHandles, scanImportEntries } from "@aura-importer/converter";
import { createAuraDatabaseWriter, type AuraDatabaseWriter } from "./database";
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
  let writer: AuraDatabaseWriter | null = null;
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
      phase: "schema",
      message: "Creating Path import database",
      completed: 0,
      total: schemaMigrations.length
    });
    writer = await createAuraDatabaseWriter(schemaMigrations, (message) => {
      postProgress(request.id, message);
    }, request.output ?? { filename: makeImportFilename() });
    const result = await convertImportFileHandles(entries, {
      onProgress: (progress) => postProgress(request.id, progress),
      onRows: (table, rows) => writer?.writeRows(table, rows)
    });
    const output = await writer.finish(result);
    writer = null;

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
    writer?.abort();
    post({
      id: request.id,
      type: "error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
