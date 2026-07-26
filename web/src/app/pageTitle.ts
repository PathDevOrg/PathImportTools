import type { WorkerProgress } from "../conversion/workerTypes";

export type AppStage = "empty" | "scanning" | "converting" | "complete" | "error";

export function pageTitle(stage: AppStage, progress: WorkerProgress | null): string {
  if (stage === "error") {
    return "Stopped - Path Import";
  }
  if (stage === "complete") {
    return "Done - Path Import";
  }
  if (progress && progress.total > 0) {
    const percent = Math.round(Math.max(0, Math.min(1, progress.completed / progress.total)) * 100);
    return `${titlePhase(progress.phase)} ${percent}% - Path Import`;
  }
  if (stage === "scanning") {
    return "Scanning - Path Import";
  }
  if (stage === "converting") {
    return "Converting - Path Import";
  }
  return "Path Import";
}

function titlePhase(phase: WorkerProgress["phase"]): string {
  switch (phase) {
    case "index":
      return "Indexing";
    case "read":
    case "parse":
      return "Parsing";
    case "normalize":
      return "Normalizing";
    case "schema":
      return "Preparing";
    case "write":
      return "Writing";
    case "verify":
      return "Verifying";
    case "export":
      return "Saving";
    case "scan":
      return "Scanning";
    case "report":
      return "Reporting";
    default:
      return "Working";
  }
}
