import {
  Archive,
  CheckCircle2,
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
  Smartphone,
  TriangleAlert,
} from "lucide-react";
import type { TranslationStrings } from "../app/i18n";
import { productCopy } from "../app/productCopy";
import { progressDetailText } from "../conversion/progressDisplay";
import type { ConversionStats, WorkerProgress } from "../conversion/workerTypes";

export type DownloadState = {
  url: string | null;
  filename: string;
  savedToDisk: boolean;
  diagnostics: string[];
  stats?: ConversionStats;
};

export function EmptyState({
  t = productCopy as unknown as TranslationStrings,
  onSelectFolder,
  onSelectZip,
  isDragging = false,
}: {
  t?: TranslationStrings;
  onSelectFolder: () => void;
  onSelectZip: () => void;
  isDragging?: boolean;
}) {
  return (
    <div className={`stage-content action-stage ${isDragging ? "is-drag-over" : ""}`}>
      <button className="primary-button" type="button" onClick={onSelectFolder}>
        <FolderOpen size={19} aria-hidden="true" />
        <span>{t.selectFolderLabel}</span>
      </button>
      <button className="text-button zip-select-btn" type="button" onClick={onSelectZip}>
        <Archive size={15} aria-hidden="true" />
        <span>{t.selectZipLabel || "or select a .zip archive"}</span>
      </button>
    </div>
  );
}

export function WorkingState({
  percent,
  progress,
  onCancel,
  t = productCopy as unknown as TranslationStrings,
}: {
  percent: number;
  progress: WorkerProgress | null;
  onCancel: () => void;
  t?: TranslationStrings;
}) {
  return (
    <div className="stage-content working-stage">
      <StageLabel value={t.workingStep} />
      <div className="working-heading">
        <Loader2 className="spin" size={22} aria-hidden="true" />
        <h2>{t.workingTitle}</h2>
      </div>
      <p className="stage-copy progress-message" title={progress?.message ?? t.workingBody}>
        {progress?.message ?? t.workingBody}
      </p>
      <ProgressBar percent={percent} progress={progress} fallbackMessage={t.workingFallback} />
      <button className="cancel-button" type="button" onClick={onCancel}>
        {t.cancelLabel}
      </button>
    </div>
  );
}

function formatDateRange(range: { startTs: number; endTs: number } | null | undefined, locale = "en"): string | null {
  if (!range || !Number.isFinite(range.startTs) || !Number.isFinite(range.endTs) || range.startTs <= 0) {
    return null;
  }
  try {
    const formatter = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short" });
    const start = formatter.format(new Date(range.startTs * 1000));
    const end = formatter.format(new Date(range.endTs * 1000));
    return `${start} — ${end}`;
  } catch {
    const start = new Date(range.startTs * 1000).toISOString().slice(0, 7);
    const end = new Date(range.endTs * 1000).toISOString().slice(0, 7);
    return `${start} — ${end}`;
  }
}

export function CompleteState({
  download,
  onSelect,
  t = productCopy as unknown as TranslationStrings,
  locale = "en",
}: {
  download: DownloadState;
  onSelect: () => void;
  t?: TranslationStrings;
  locale?: string;
}) {
  const dateSpan = formatDateRange(download.stats?.dateRange, locale);
  const days = download.stats?.dateRange
    ? Math.max(1, Math.round((download.stats.dateRange.endTs - download.stats.dateRange.startTs) / 86400))
    : null;

  return (
    <div className="stage-content">
      <StageLabel value={t.completeStep} />
      <div className="complete-mark">
        <CheckCircle2 size={24} aria-hidden="true" />
      </div>
      <h2>{t.completeTitle}</h2>
      <p className="stage-copy">{download.savedToDisk ? t.completeSavedBody : t.completeDownloadBody}</p>

      <div className="secondary-actions complete-actions">
        {download.savedToDisk ? (
          <div className="saved-status-badge">
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>{t.savedStatus}</span>
          </div>
        ) : download.url ? (
          <a className="secondary-button" href={download.url} download={download.filename}>
            <Download size={18} aria-hidden="true" />
            <span>{t.downloadAgainLabel}</span>
          </a>
        ) : null}
        <button className="secondary-button" type="button" onClick={onSelect}>
          <RefreshCw size={18} aria-hidden="true" />
          <span>{t.chooseAnotherLabel}</span>
        </button>
      </div>

      {download.stats && (download.stats.stays > 0 || download.stats.moves > 0) ? (
        <section className="conversion-stats-card" aria-label={t.statsSummary || "Summary"}>
          {dateSpan ? <div className="stats-dates">{dateSpan}</div> : null}
          <div className="stats-grid">
            {days ? (
              <div className="stats-item">
                <span className="stats-num">{days.toLocaleString()}</span>
                <span className="stats-label">{t.statsDays || "days"}</span>
              </div>
            ) : null}
            <div className="stats-item">
              <span className="stats-num">{download.stats.stays.toLocaleString()}</span>
              <span className="stats-label">{t.statsStays || "stays"}</span>
            </div>
            <div className="stats-item">
              <span className="stats-num">{download.stats.moves.toLocaleString()}</span>
              <span className="stats-label">{t.statsMoves || "trips"}</span>
            </div>
            <div className="stats-item">
              <span className="stats-num">{download.stats.pois.toLocaleString()}</span>
              <span className="stats-label">{t.statsPois || "places"}</span>
            </div>
          </div>
        </section>
      ) : null}

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

      <div className="handoff-card">
        <div className="handoff-header">
          <Smartphone size={16} aria-hidden="true" />
          <strong>{t.handoffTitle || "How to import into Path on iPhone"}</strong>
        </div>
        <ol className="handoff-steps">
          <li>{t.handoffStep1}</li>
          <li>{t.handoffStep2}</li>
          <li>{t.handoffStep3}</li>
        </ol>
      </div>
    </div>
  );
}

export function ErrorState({
  message,
  onSelect,
  title,
  t = productCopy as unknown as TranslationStrings,
}: {
  message: string | null;
  onSelect: () => void;
  title?: string;
  t?: TranslationStrings;
}) {
  return (
    <div className="stage-content">
      <StageLabel value={t.completeStep} />
      <div className="error-mark">
        <TriangleAlert size={24} aria-hidden="true" />
      </div>
      <h2>{title ?? t.errorTitle}</h2>
      <p className="stage-copy">{message ?? t.errorFallback}</p>
      <button className="secondary-button" type="button" onClick={onSelect}>
        <FolderOpen size={19} aria-hidden="true" />
        <span>{t.selectFolderLabel}</span>
      </button>
    </div>
  );
}

export function PrivacyFooter({ t = productCopy as unknown as TranslationStrings }: { t?: TranslationStrings }) {
  const parts = splitPrivacySentences(t.privacyStatement);
  return (
    <footer className="privacy-footer">
      <p className="privacy-statement">
        {parts.map((part) => (
          <span key={part} className="privacy-phrase">
            {part}
          </span>
        ))}
      </p>
    </footer>
  );
}

function splitPrivacySentences(statement: string): string[] {
  const parts: string[] = [];
  let remaining = statement;
  while (remaining) {
    const match = remaining.match(/^(.*?[。.]\s*)(.*)$/);
    if (match?.[2]) {
      parts.push(match[1]);
      remaining = match[2];
    } else {
      parts.push(remaining);
      break;
    }
  }
  return parts.length > 0 ? parts : [statement];
}

function StageLabel({ value }: { value: string }) {
  return <p className="stage-label">{value}</p>;
}

function ProgressBar({
  percent,
  progress,
  fallbackMessage,
}: {
  percent: number;
  progress: WorkerProgress | null;
  fallbackMessage: string;
}) {
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
        <span>{progress ? progressDetailText(progress) : fallbackMessage}</span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
