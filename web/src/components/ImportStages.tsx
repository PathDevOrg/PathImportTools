import { CheckCircle2, Download, FolderOpen, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { productCopy } from "../app/productCopy";
import { progressDetailText } from "../conversion/progressDisplay";
import type { WorkerProgress } from "../conversion/workerTypes";

export type DownloadState = {
  url: string | null;
  filename: string;
  savedToDisk: boolean;
  diagnostics: string[];
};

export function EmptyState({ onSelect }: { onSelect: () => void }) {
  return (
    <div className="stage-content action-stage">
      <button className="primary-button" type="button" onClick={onSelect}>
        <FolderOpen size={19} aria-hidden="true" />
        <span>{productCopy.selectFolderLabel}</span>
      </button>
    </div>
  );
}

export function WorkingState({
  percent,
  progress,
  onCancel,
}: {
  percent: number;
  progress: WorkerProgress | null;
  onCancel: () => void;
}) {
  return (
    <div className="stage-content working-stage">
      <StageLabel value={productCopy.workingStep} />
      <div className="working-heading">
        <Loader2 className="spin" size={22} aria-hidden="true" />
        <h2>{productCopy.workingTitle}</h2>
      </div>
      <p className="stage-copy progress-message" title={progress?.message ?? productCopy.workingBody}>
        {progress?.message ?? productCopy.workingBody}
      </p>
      <ProgressBar percent={percent} progress={progress} />
      <button className="cancel-button" type="button" onClick={onCancel}>
        {productCopy.cancelLabel}
      </button>
    </div>
  );
}

export function CompleteState({ download, onSelect }: { download: DownloadState; onSelect: () => void }) {
  return (
    <div className="stage-content">
      <StageLabel value={productCopy.completeStep} />
      <div className="complete-mark">
        <CheckCircle2 size={24} aria-hidden="true" />
      </div>
      <h2>{productCopy.completeTitle}</h2>
      <p className="stage-copy">
        {download.savedToDisk ? productCopy.completeSavedBody : productCopy.completeDownloadBody}
      </p>
      {download.diagnostics.length > 0 ? (
        <div className="conversion-warnings" role="status">
          <div>
            <TriangleAlert size={18} aria-hidden="true" />
            <strong>
              {download.diagnostics.length} data warning{download.diagnostics.length === 1 ? "" : "s"}
            </strong>
          </div>
          <ul>
            {download.diagnostics.slice(0, 3).map((diagnostic) => (
              <li key={diagnostic}>{diagnostic}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="secondary-actions">
        {download.url ? (
          <a className="secondary-button" href={download.url} download={download.filename}>
            <Download size={18} aria-hidden="true" />
            <span>{productCopy.downloadAgainLabel}</span>
          </a>
        ) : (
          <span className="saved-pill">{productCopy.savedStatus}</span>
        )}
        <button className="secondary-button" type="button" onClick={onSelect}>
          <RefreshCw size={18} aria-hidden="true" />
          <span>{productCopy.chooseAnotherLabel}</span>
        </button>
      </div>
    </div>
  );
}

export function ErrorState({
  message,
  onSelect,
  title,
}: {
  message: string | null;
  onSelect: () => void;
  title?: string;
}) {
  return (
    <div className="stage-content">
      <div className="error-mark">
        <TriangleAlert size={24} aria-hidden="true" />
      </div>
      <h2>{title ?? productCopy.errorTitle}</h2>
      <p className="stage-copy">{message ?? productCopy.errorFallback}</p>
      <button className="primary-button" type="button" onClick={onSelect}>
        <FolderOpen size={19} aria-hidden="true" />
        <span>{productCopy.selectFolderLabel}</span>
      </button>
    </div>
  );
}

export function PrivacyFooter() {
  return (
    <footer className="privacy-footer">
      <p className="privacy-statement">{productCopy.privacyStatement}</p>
    </footer>
  );
}

function StageLabel({ value }: { value: string }) {
  return <p className="stage-label">{value}</p>;
}

function ProgressBar({ percent, progress }: { percent: number; progress: WorkerProgress | null }) {
  return (
    <div
      className="progress-panel"
      role="progressbar"
      aria-label="Conversion progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
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
