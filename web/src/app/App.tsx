import { useEffect, useRef, useState } from "react";
import { CompleteState, EmptyState, ErrorState, PrivacyFooter, WorkingState, type DownloadState } from "../components/ImportStages";
import { pickDirectoryFiles, type DirectoryPickerHost, type PickedDirectoryFile } from "../conversion/directoryPicker";
import { makeImportFilename, makeUniqueImportFilename } from "../conversion/outputFilename";
import { makeWorkerOutputTarget, type SaveFilePickerHost } from "../conversion/outputTarget";
import { progressPercent } from "../conversion/progressDisplay";
import type { WorkerFilePayload, WorkerOutputTarget, WorkerProgress, WorkerRequest, WorkerResponse } from "../conversion/workerTypes";
import { pageTitle, type AppStage } from "./pageTitle";
import { productCopy } from "./productCopy";

type Stage = AppStage;

type SelectedFile = PickedDirectoryFile;

export function App() {
  const directoryInputRef = useRef<HTMLInputElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const activeRequestRef = useRef<string | null>(null);
  const filesRef = useRef<SelectedFile[]>([]);
  const downloadUrlRef = useRef<string | null>(null);
  const outputTokenRef = useRef<string | null>(null);
  const autoDownloadedUrlRef = useRef<string | null>(null);
  const outputDirectoryRef = useRef<FileSystemDirectoryHandle | null>(null);
  const outputFilenameRef = useRef<string | null>(null);
  const shouldAskForSaveLocationRef = useRef(false);
  const [stage, setStage] = useState<Stage>("empty");
  const [progressDetail, setProgressDetail] = useState<WorkerProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorTitle, setErrorTitle] = useState<string | null>(null);
  const [download, setDownload] = useState<DownloadState | null>(null);

  useEffect(() => {
    const input = directoryInputRef.current;
    if (input) {
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("directory", "");
    }
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL("../conversion/converter.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.id !== activeRequestRef.current) {
        return;
      }
      if (response.type === "progress") {
        setProgressDetail(response.progress);
      } else if (response.type === "scan-complete") {
        void handleScanComplete(response.id, response.scan.supportedFileCount);
      } else if (response.type === "convert-complete") {
        const url = response.file
          ? URL.createObjectURL(response.file)
          : response.bytes
            ? URL.createObjectURL(new Blob([arrayBufferForBlob(response.bytes)], { type: "application/vnd.sqlite3" }))
            : null;
        if (downloadUrlRef.current) {
          revokeAfterDownloadHandoff(downloadUrlRef.current);
        }
        if (outputTokenRef.current) {
          worker.postMessage({ id: crypto.randomUUID(), type: "release-output", outputToken: outputTokenRef.current } satisfies WorkerRequest);
        }
        downloadUrlRef.current = url;
        outputTokenRef.current = response.outputToken ?? null;
        autoDownloadedUrlRef.current = null;
        setDownload({ url, filename: response.filename, savedToDisk: response.savedToDisk, diagnostics: response.diagnostics });
        setStage("complete");
        setProgressDetail({
          phase: "export",
          message: response.savedToDisk ? "File saved" : "Download ready",
          completed: 1,
          total: 1
        });
      } else if (response.type === "error") {
        setStage("error");
        setErrorTitle(productCopy.errorUnknownTitle);
        setError(response.message ?? "We could not finish the conversion. Choose another folder and try again.");
        setProgressDetail(null);
      }
    };

    return () => {
      worker.terminate();
      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    document.title = pageTitle(stage, progressDetail);
  }, [progressDetail, stage]);

  useEffect(() => {
    if (stage !== "complete" || !download?.url || autoDownloadedUrlRef.current === download.url) {
      return;
    }
    autoDownloadedUrlRef.current = download.url;
    const anchor = document.createElement("a");
    anchor.href = download.url;
    anchor.download = download.filename;
    anchor.rel = "noreferrer";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }, [download, stage]);

  async function handleScanComplete(requestId: string, supportedFileCount: number) {
    if (supportedFileCount <= 0) {
      setStage("error");
      setErrorTitle(null);
      setError("We could not find data Path can convert in this folder.");
      setProgressDetail(null);
      return;
    }

    try {
      const outputDirectory = outputDirectoryRef.current;
      const outputFilename = outputFilenameRef.current ?? makeImportFilename();
      const selectedOutput = outputDirectory ? await makeDirectoryOutputTarget(outputDirectory, outputFilename) : shouldAskForSaveLocationRef.current ? await makeWorkerOutputTarget(window as SaveFilePickerHost, outputFilename) : { filename: outputFilename };
      const storage = (navigator as Navigator & {
        storage?: { getDirectory?: unknown };
      }).storage;
      const output = selectedOutput && !selectedOutput.saveHandle && typeof storage?.getDirectory === "function"
        ? { ...selectedOutput, opfsDownload: true }
        : selectedOutput;
      if (activeRequestRef.current !== requestId) {
        return;
      }
      if (!output) {
        setStage("empty");
        setProgressDetail(null);
        return;
      }
      sendToWorker("convert", filesRef.current, output);
    } catch {
      if (activeRequestRef.current !== requestId) {
        return;
      }
      setStage("error");
      setErrorTitle(productCopy.errorUnknownTitle);
      setError("We could not open a place to save the import file.");
      setProgressDetail(null);
    }
  }

  async function selectBackupFolder() {
    try {
      const selection = await pickDirectoryFiles(window as DirectoryPickerHost, makeImportFilename());
      if (selection === null) {
        directoryInputRef.current?.click();
        return;
      }
      outputDirectoryRef.current = selection.directory;
      outputFilenameRef.current = selection.filename;
      shouldAskForSaveLocationRef.current = false;
      selectPickedFiles(selection.files);
    } catch {
      setStage("error");
      setErrorTitle(productCopy.errorUnknownTitle);
      setError("We could not open this folder.");
      setProgressDetail(null);
    }
  }

  function selectInputFiles(list: FileList | null) {
    outputDirectoryRef.current = null;
    outputFilenameRef.current = null;
    shouldAskForSaveLocationRef.current = true;
    selectPickedFiles(Array.from(list ?? []).map((file) => ({
      file,
      path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    })));
  }

  function selectPickedFiles(nextFiles: PickedDirectoryFile[]) {
    filesRef.current = nextFiles;
    setError(null);
    setErrorTitle(null);
    setProgressDetail(null);
    if (downloadUrlRef.current) {
      revokeAfterDownloadHandoff(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
    if (outputTokenRef.current && workerRef.current) {
      workerRef.current.postMessage({ id: crypto.randomUUID(), type: "release-output", outputToken: outputTokenRef.current } satisfies WorkerRequest);
      outputTokenRef.current = null;
    }
    autoDownloadedUrlRef.current = null;
    setDownload(null);

    if (nextFiles.length === 0) {
      setStage("empty");
      setProgressDetail(null);
      return;
    }

    sendToWorker("scan", nextFiles);
  }

  function sendToWorker(type: "scan" | "convert", selectedFiles: SelectedFile[], output?: WorkerOutputTarget) {
    const worker = workerRef.current;
    if (!worker || selectedFiles.length === 0) {
      return;
    }
    const id = crypto.randomUUID();
    activeRequestRef.current = id;
    const payload: WorkerFilePayload[] = selectedFiles.map((item) => ({ path: item.path, file: item.file }));
    setStage(type === "scan" ? "scanning" : "converting");
    setError(null);
    setErrorTitle(null);
    setProgressDetail(null);
    const request: WorkerRequest = type === "scan" ? { id, type, files: payload } : { id, type, files: payload, output: output ?? { filename: makeImportFilename() } };
    worker.postMessage(request);
  }

  const percent = progressPercent(stage, progressDetail);

  return (
    <main className="app-shell">
      <nav className="topbar" aria-label={productCopy.appName}>
        <a className="brand-lockup" href="/" aria-label={productCopy.navHomeLabel}>
          <img src="/path-logo.png" alt="" />
          <strong>{productCopy.appName}</strong>
        </a>
        <a className="app-store-badge" href={productCopy.appDownloadHref} aria-label={productCopy.downloadAppLabel}>
          <img src="/download-on-the-app-store.svg" alt={productCopy.downloadAppLabel} />
        </a>
      </nav>

      <section className="import-shell" aria-labelledby="import-title">
        <h1 id="import-title">{productCopy.heroTitle}</h1>
        <p className="hero-copy">{productCopy.heroBody}</p>

        <section className="workflow-surface" aria-live="polite">
          {stage === "empty" ? <EmptyState onSelect={() => void selectBackupFolder()} /> : null}
          {stage === "scanning" || stage === "converting" ? <WorkingState percent={percent} progress={progressDetail} /> : null}
          {stage === "complete" && download ? <CompleteState download={download} onSelect={() => void selectBackupFolder()} /> : null}
          {stage === "error" ? <ErrorState message={error} title={errorTitle ?? undefined} onSelect={() => void selectBackupFolder()} /> : null}
        </section>

        <input
          ref={directoryInputRef}
          className="hidden-input"
          type="file"
          multiple
          onChange={(event) => {
            selectInputFiles(event.target.files);
            event.currentTarget.value = "";
          }}
        />
      </section>

      <PrivacyFooter />
    </main>
  );
}

async function makeDirectoryOutputTarget(directory: FileSystemDirectoryHandle, filename: string): Promise<WorkerOutputTarget> {
  const uniqueFilename = await makeUniqueImportFilename(directory, filename);
  const saveHandle = await directory.getFileHandle(uniqueFilename, { create: true });
  return { filename: saveHandle.name || uniqueFilename, saveHandle };
}

function arrayBufferForBlob(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

function revokeAfterDownloadHandoff(url: string): void {
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
