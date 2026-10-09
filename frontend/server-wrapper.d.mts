export declare const DRAIN_CAP_MS: number;

export interface DrainOptions {
  capMs?: number;
  exit?: (code?: number) => void;
  proc?: Pick<NodeJS.EventEmitter, "on">;
}

export declare function drainOnSignal(
  options: DrainOptions & { server: { close(cb: () => void): unknown } },
): () => void;

export declare const CAPTURE_TIMEOUT_MS: number;

export declare function start(
  options?: DrainOptions & { importServer?: () => Promise<unknown>; captureTimeoutMs?: number },
): Promise<void>;
