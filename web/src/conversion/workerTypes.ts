import type { ImportProgressPhase, ImportScan } from "@aura-importer/converter";

export type WorkerFilePayload = {
  path: string;
  file: File;
};

export type WorkerOutputTarget = {
  filename: string;
  saveHandle?: FileSystemFileHandle;
  opfsDownload?: boolean;
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
  }
  | {
    id: string;
    type: "release-output";
    outputToken: string;
  };

export type WorkerProgress = {
  phase: ImportProgressPhase | "index" | "schema" | "write" | "verify" | "export";
  message: string;
  completed: number;
  total: number;
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
    filename: string;
    savedToDisk: boolean;
    diagnostics: string[];
    bytes?: Uint8Array;
    file?: File;
    outputToken?: string;
  }
  | {
    id: string;
    type: "error";
    message: string;
  };
