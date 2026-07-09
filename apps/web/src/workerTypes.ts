import type { ImportProgressPhase, ImportReport, ImportScan } from "@aura-importer/converter";

export type WorkerFilePayload = {
  path: string;
  file: File;
};

export type WorkerOutputTarget = {
  filename: string;
  saveHandle?: FileSystemFileHandle;
};

export type WorkerRequest =
  | {
    id: string;
    type: "scan";
    files: WorkerFilePayload[];
  }
  | {
    id: string;
    type: "convert";
    files: WorkerFilePayload[];
    output: WorkerOutputTarget;
  };

export type WorkerProgress = {
  phase: ImportProgressPhase | "index" | "schema" | "write" | "verify" | "export";
  message: string;
  completed: number;
  total: number;
  bytesCompleted?: number;
  bytesTotal?: number;
};

export type WorkerResponse =
  | {
    id: string;
    type: "progress";
    message: string;
    progress: WorkerProgress;
  }
  | {
    id: string;
    type: "scan-complete";
    scan: ImportScan;
  }
  | {
    id: string;
    type: "convert-complete";
    report: ImportReport;
    filename: string;
    size: number;
    savedToDisk: boolean;
    bytes?: Uint8Array;
  }
  | {
    id: string;
    type: "error";
    message: string;
  };
