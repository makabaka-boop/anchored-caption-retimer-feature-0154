import type {
  LevelGraph,
  MediaRecorderLike,
  MediaStreamLike,
  NarrationMediaAdapter,
} from './mediaAdapter';

export { MIME_CANDIDATES } from './mediaAdapter';
export type { RecorderDataEvent } from './mediaAdapter';

interface RecorderCtor {
  new (stream: MediaStream, options?: { mimeType?: string }): MediaRecorderLike;
  isTypeSupported?(type: string): boolean;
}

class BrowserLevelGraph implements LevelGraph {
  private readonly ctx: AudioContext;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly analyser: AnalyserNode;
  private readonly buf: Uint8Array<ArrayBuffer>;
  private closed = false;

  constructor(stream: MediaStream) {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    // Construction happens inside the user-gesture-initiated enable() chain,
    // so a suspended autoplay-policy context gets resumed straight away.
    const ctx = new Ctor!();
    void ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    this.ctx = ctx;
    this.source = source;
    this.analyser = analyser;
    this.buf = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  }

  sampleLevel(): number | null {
    if (this.closed) return null;
    this.analyser.getByteTimeDomainData(this.buf);
    let peak = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = Math.abs(this.buf[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return Math.min(1, peak);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.source.disconnect();
    } catch {
      // already gone
    }
    void this.ctx.close().catch(() => undefined);
  }
}

export function createBrowserAdapter(): NarrationMediaAdapter {
  const nav = navigator as Navigator | undefined;
  const Recorder = (
    typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined
  ) as RecorderCtor | undefined;
  const isSupported =
    typeof nav !== 'undefined' &&
    typeof nav.mediaDevices?.getUserMedia === 'function' &&
    Recorder !== undefined &&
    typeof (window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext) === 'function';

  return {
    isSupported,

    async getUserMedia(): Promise<MediaStreamLike> {
      // Re-read at call time; a missing API throws synchronously as if denied.
      return (await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      })) as MediaStream;
    },

    createLevelGraph(stream: MediaStreamLike): LevelGraph {
      return new BrowserLevelGraph(stream as MediaStream);
    },

    pickMimeType(candidates: readonly string[]): string {
      for (const type of candidates) {
        try {
          if (Recorder?.isTypeSupported?.(type)) return type;
        } catch {
          return '';
        }
      }
      return '';
    },

    createRecorder(
      stream: MediaStreamLike,
      mimeType: string,
    ): MediaRecorderLike {
      // A negotiated empty string means "platform default"; passing an
      // unsupported type would make the constructor throw on some engines.
      const options = mimeType ? { mimeType } : undefined;
      return new Recorder!(stream as MediaStream, options);
    },

    assembleBlob(chunks, mimeType): { readonly size: number } {
      return new Blob(chunks as BlobPart[], { type: mimeType });
    },

    createObjectURL(blob: Blob): string {
      return URL.createObjectURL(blob);
    },

    revokeObjectURL(url: string): void {
      URL.revokeObjectURL(url);
    },

    now(): number {
      // performance.now() is a monotonic clock, independent of rAF ticks and
      // of background-tab timer throttling.
      return performance.now();
    },

    requestFrame(cb: () => void): number {
      return requestAnimationFrame(() => cb());
    },

    cancelFrame(handle: number): void {
      cancelAnimationFrame(handle);
    },
  };
}
