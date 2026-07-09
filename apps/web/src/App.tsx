import { CheckCircle2, Download, FolderOpen, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { pickDirectoryFiles, type DirectoryPickerHost, type PickedDirectoryFile } from "./directoryPicker";
import { makeImportFilename } from "./outputFilename";
import { makeWorkerOutputTarget, type SaveFilePickerHost } from "./outputTarget";
import { pageTitle, type AppStage } from "./pageTitle";
import { productCopy } from "./productCopy";
import { progressDetailText, progressPercent } from "./progressDisplay";
import type { WorkerFilePayload, WorkerOutputTarget, WorkerProgress, WorkerRequest, WorkerResponse } from "./workerTypes";

type Stage = AppStage;

type SelectedFile = PickedDirectoryFile;

type DownloadState = {
  url: string | null;
  filename: string;
  savedToDisk: boolean;
};

export function App() {
  const directoryInputRef = useRef<HTMLInputElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const activeRequestRef = useRef<string | null>(null);
  const filesRef = useRef<SelectedFile[]>([]);
  const downloadUrlRef = useRef<string | null>(null);
  const autoDownloadedUrlRef = useRef<string | null>(null);
  const shouldAskForSaveLocationRef = useRef(false);
  const [stage, setStage] = useState<Stage>("empty");
  const [progressDetail, setProgressDetail] = useState<WorkerProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<DownloadState | null>(null);

  useEffect(() => {
    const input = directoryInputRef.current;
    if (input) {
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("directory", "");
    }
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL("./converter.worker.ts", import.meta.url), { type: "module" });
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
        const url = response.bytes ? URL.createObjectURL(new Blob([arrayBufferForBlob(response.bytes)], { type: "application/vnd.sqlite3" })) : null;
        if (downloadUrlRef.current) {
          URL.revokeObjectURL(downloadUrlRef.current);
        }
        downloadUrlRef.current = url;
        autoDownloadedUrlRef.current = null;
        setDownload({ url, filename: response.filename, savedToDisk: response.savedToDisk });
        setStage("complete");
        setProgressDetail({
          phase: "export",
          message: response.savedToDisk ? "File saved" : "Download ready",
          completed: 1,
          total: 1
        });
      } else if (response.type === "error") {
        setStage("error");
        setError("We could not finish the conversion. Choose another folder and try again.");
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
      setError("We could not find data Path can convert in this folder.");
      setProgressDetail(null);
      return;
    }

    try {
      const output = shouldAskForSaveLocationRef.current ? await makeWorkerOutputTarget(window as SaveFilePickerHost, makeImportFilename()) : { filename: makeImportFilename() };
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
      setError("We could not open a place to save the import file.");
      setProgressDetail(null);
    }
  }

  async function selectBackupFolder() {
    try {
      const pickedFiles = await pickDirectoryFiles(window as DirectoryPickerHost);
      if (pickedFiles === null) {
        directoryInputRef.current?.click();
        return;
      }
      shouldAskForSaveLocationRef.current = false;
      selectPickedFiles(pickedFiles);
    } catch {
      setStage("error");
      setError("We could not open this folder.");
      setProgressDetail(null);
    }
  }

  function selectInputFiles(list: FileList | null) {
    shouldAskForSaveLocationRef.current = true;
    selectPickedFiles(Array.from(list ?? []).map((file) => ({
      file,
      path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    })));
  }

  function selectPickedFiles(nextFiles: PickedDirectoryFile[]) {
    filesRef.current = nextFiles;
    setError(null);
    setProgressDetail(null);
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
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

  function sendToWorker(type: WorkerRequest["type"], selectedFiles: SelectedFile[], output?: WorkerOutputTarget) {
    const worker = workerRef.current;
    if (!worker || selectedFiles.length === 0) {
      return;
    }
    const id = crypto.randomUUID();
    activeRequestRef.current = id;
    const payload: WorkerFilePayload[] = selectedFiles.map((item) => ({ path: item.path, file: item.file }));
    setStage(type === "scan" ? "scanning" : "converting");
    setError(null);
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
          {stage === "error" ? <ErrorState message={error} onSelect={() => void selectBackupFolder()} /> : null}
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

function EmptyState({ onSelect }: { onSelect: () => void }) {
  return (
    <div className="stage-content action-stage">
      <button className="primary-button" type="button" onClick={onSelect}>
        <FolderOpen size={19} />
        <span>{productCopy.selectFolderLabel}</span>
      </button>
    </div>
  );
}

function WorkingState({ percent, progress }: { percent: number; progress: WorkerProgress | null }) {
  return (
    <div className="stage-content working-stage">
      <StageLabel value={productCopy.workingStep} />
      <div className="working-heading">
        <Loader2 className="spin" size={22} />
        <h2>{productCopy.workingTitle}</h2>
      </div>
      <p className="stage-copy progress-message" title={progress?.message ?? productCopy.workingBody}>{progress?.message ?? productCopy.workingBody}</p>
      <ProgressBar percent={percent} progress={progress} />
    </div>
  );
}

function CompleteState({ download, onSelect }: { download: DownloadState; onSelect: () => void }) {
  return (
    <div className="stage-content">
      <StageLabel value={productCopy.completeStep} />
      <div className="complete-mark">
        <CheckCircle2 size={24} />
      </div>
      <h2>{productCopy.completeTitle}</h2>
      <p className="stage-copy">{download.savedToDisk ? productCopy.completeSavedBody : productCopy.completeDownloadBody}</p>
      <div className="secondary-actions">
        {download.url ? (
          <a className="secondary-button" href={download.url} download={download.filename}>
            <Download size={18} />
            <span>{productCopy.downloadAgainLabel}</span>
          </a>
        ) : (
          <span className="saved-pill">{productCopy.savedStatus}</span>
        )}
        <button className="secondary-button" type="button" onClick={onSelect}>
          <RefreshCw size={18} />
          <span>{productCopy.chooseAnotherLabel}</span>
        </button>
      </div>
    </div>
  );
}

function ErrorState({ message, onSelect }: { message: string | null; onSelect: () => void }) {
  return (
    <div className="stage-content">
      <div className="error-mark">
        <TriangleAlert size={24} />
      </div>
      <h2>{productCopy.errorTitle}</h2>
      <p className="stage-copy">{message ?? productCopy.errorFallback}</p>
      <button className="primary-button" type="button" onClick={onSelect}>
        <FolderOpen size={19} />
        <span>{productCopy.selectFolderLabel}</span>
      </button>
    </div>
  );
}

function StageLabel({ value }: { value: string }) {
  return <p className="stage-label">{value}</p>;
}

function PrivacyFooter() {
  return (
    <footer className="privacy-footer">
      <ul className="privacy-list" aria-label="Privacy guarantees">
        <li>{productCopy.privacyOne}</li>
        <li>{productCopy.privacyTwo}</li>
        <li>{productCopy.privacyThree}</li>
      </ul>
    </footer>
  );
}

function ProgressBar({ percent, progress }: { percent: number; progress: WorkerProgress | null }) {
  return (
    <div className="progress-panel" aria-label="Conversion progress">
      <div className="progress-meta">
        <strong>{percent}%</strong>
        <span>{progress ? progressDetailText(progress) : productCopy.workingFallback}</span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function arrayBufferForBlob(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}
