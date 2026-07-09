import type { AppStage } from "./pageTitle";
import type { WorkerProgress } from "./workerTypes";

export function progressDetailText(progress: WorkerProgress): string {
  return `${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}`;
}

export function progressPercent(stage: AppStage, progress: WorkerProgress | null): number {
  if (stage === "complete") {
    return 100;
  }
  if (!progress || progress.total <= 0) {
    return 0;
  }
  const raw = Math.round(Math.max(0, Math.min(1, progress.completed / progress.total)) * 100);
  return Math.min(raw, 99);
}
