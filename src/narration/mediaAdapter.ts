// Injectable media adapter for the live narration booth.
//
// Every browser media call the recorder needs goes through this interface, so
// the whole session state machine can be exercised under Vitest with a fake
// adapter (no getUserMedia, no MediaRecorder, no AudioContext).
//
// Contract for all implementations:
//   - constructors / factories never prompt for permission and never create
//     devices: getUserMedia is only invoked on an explicit enable();
//   - recorders receive exactly one final dataavailable (size > 0) before stop;
//   - requestFrame drives visual refreshes only — audio capture and chunk
//     collection must keep working when it stops being called (background tab).

// Preferred container/codec order negotiated before constructing each
// recorder; the first type the platform says it can actually encode wins.
export const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const;

export interface RecorderDataEvent {
  readonly data: { readonly size: number };
}

export type RecorderEventType = 'dataavailable' | 'stop' | 'error';

export interface MediaRecorderLike {
  readonly state: 'inactive' | 'recording' | 'paused';
  readonly mimeType: string;
  start(): void;
  stop(): void;
  addEventListener(
    type: RecorderEventType,
    listener: (event: RecorderDataEvent) => void,
  ): void;
  removeEventListener(
    type: RecorderEventType,
    listener: (event: RecorderDataEvent) => void,
  ): void;
}

export interface MediaStreamLike {
  getAudioTracks(): Array<{
    stop(): void;
    readyState: 'live' | 'ended';
    addEventListener(type: 'ended', listener: () => void): void;
    removeEventListener(type: 'ended', listener: () => void): void;
  }>;
}

/** AnalyserNode sampling surface: pull a frequency-independent input level. */
export interface LevelGraph {
  /** Instant input level in 0..1; null means data is not ready yet. */
  sampleLevel(): number | null;
  /** Idempotent: tear the audio graph down; stops its source tracks itself. */
  close(): void;
}

export interface NarrationMediaAdapter {
  /** Static capability flag; checked synchronously on enable(). */
  readonly isSupported: boolean;
  /** Explicit user gesture entry point; may reject with a DOMException-ish. */
  getUserMedia(): Promise<MediaStreamLike>;
  /** Analyser graph sourcing from the granted stream (source keeps it live). */
  createLevelGraph(stream: MediaStreamLike): LevelGraph;
  /** First supported candidate MIME type, or '' when none negotiates. */
  pickMimeType(candidates: readonly string[]): string;
  createRecorder(
    stream: MediaStreamLike,
    mimeType: string,
  ): MediaRecorderLike;
  /** Assemble collected blocks into a finished blob (injectable for tests). */
  assembleBlob(
    chunks: ReadonlyArray<{ readonly size: number }>,
    mimeType: string,
  ): { readonly size: number };
  createObjectURL(blob: { readonly size: number }): string;
  revokeObjectURL(url: string): void;
  now(): number;
  requestFrame(cb: () => void): number;
  cancelFrame(handle: number): void;
}
