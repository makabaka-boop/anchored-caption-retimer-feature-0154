import type {
  LevelGraph,
  MediaRecorderLike,
  MediaStreamLike,
  NarrationMediaAdapter,
  RecorderDataEvent,
} from './mediaAdapter';

// Deterministic in-memory media adapter for Vitest: no real devices, clocks or
// object URLs. Everything the session machine touches is observable so tests
// can assert tracks stopped, graphs closed and URLs revoked.

export type GrantMode =
  | 'allow'
  | { reject: Error }
  | 'no-tracks'
  | 'ended-track';

export interface FakeAdapterOptions {
  isSupported?: boolean;
  grant?: GrantMode;
  mimeType?: string;
  recorderCtorThrows?: boolean;
  graphCtorThrows?: boolean;
  recorderStartThrows?: boolean;
  /** Size of the block the fake recorder drains when stop() is requested. */
  finalSize?: number;
  assemble?: 'ok' | 'throw' | 'empty';
  createUrlThrows?: boolean;
  level?: number | null;
  autoFinal?: boolean;
  startTime?: number;
}

type RecListener = (event: RecorderDataEvent) => void;

export class FakeRecorder implements MediaRecorderLike {
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  readonly mimeType: string;
  startCount = 0;
  stopCount = 0;
  startThrows = false;

  private readonly listeners: Record<
    'dataavailable' | 'stop' | 'error',
    Set<RecListener>
  > = {
    dataavailable: new Set(),
    stop: new Set(),
    error: new Set(),
  };

  constructor(
    private readonly opts: {
      mimeType: string;
      finalSize: number;
      autoFinal: boolean;
      startThrows: boolean;
    },
  ) {
    this.mimeType = opts.mimeType;
    this.startThrows = opts.startThrows;
  }

  addEventListener(type: 'dataavailable' | 'stop' | 'error', l: RecListener) {
    this.listeners[type].add(l);
  }

  removeEventListener(type: 'dataavailable' | 'stop' | 'error', l: RecListener) {
    this.listeners[type].delete(l);
  }

  listenerCount(type: 'dataavailable' | 'stop' | 'error'): number {
    return this.listeners[type].size;
  }

  start(): void {
    this.startCount++;
    if (this.startThrows) throw new Error('start failed');
    this.state = 'recording';
  }

  stop(): void {
    this.stopCount++;
    this.state = 'inactive';
    if (this.opts.autoFinal) {
      // Real MediaRecorder delivers these asynchronously, after stop() returns.
      const size = this.opts.finalSize;
      queueMicrotask(() => this.fireData(size));
      queueMicrotask(() => this.fireStop());
    }
  }

  fireData(size: number): void {
    const event: RecorderDataEvent = { data: { size } };
    for (const l of [...this.listeners.dataavailable]) l(event);
  }

  fireStop(): void {
    for (const l of [...this.listeners.stop]) l({ data: { size: 0 } });
  }

  fireError(): void {
    for (const l of [...this.listeners.error]) l({ data: { size: 0 } });
  }
}

export class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  stopCount = 0;
  private endedListeners = new Set<() => void>();

  constructor(startEnded = false) {
    if (startEnded) this.readyState = 'ended';
  }

  addEventListener(_type: 'ended', l: () => void): void {
    this.endedListeners.add(l);
  }

  removeEventListener(_type: 'ended', l: () => void): void {
    this.endedListeners.delete(l);
  }

  stop(): void {
    this.stopCount++;
    this.readyState = 'ended';
  }

  fireEnded(): void {
    this.readyState = 'ended';
    for (const l of [...this.endedListeners]) l();
  }

  get endedListenerCount(): number {
    return this.endedListeners.size;
  }
}

class FakeGraph implements LevelGraph {
  closed = false;
  closeCount = 0;
  constructor(private readonly level: number | null) {}
  sampleLevel(): number | null {
    return this.closed ? null : this.level;
  }
  close(): void {
    if (!this.closed) this.closeCount++;
    this.closed = true;
  }
}

export class FakeMediaAdapter implements NarrationMediaAdapter {
  isSupported: boolean;

  getUserMediaCount = 0;
  tracks: FakeTrack[] = [];
  streams: MediaStreamLike[] = [];
  recorders: FakeRecorder[] = [];
  graphs: FakeGraph[] = [];
  negotiatedTypes: string[] = [];
  createdUrls: string[] = [];
  revokedUrls: string[] = [];
  assembledSizes: number[] = [];

  grant: GrantMode;
  private readonly mimeType: string;
  private readonly opts: FakeAdapterOptions;
  private urlSeq = 0;
  private frameSeq = 1;
  private currentTime: number;
  private readonly handles = new Map<number, () => void>();

  constructor(opts: FakeAdapterOptions = {}) {
    this.opts = opts;
    this.isSupported = opts.isSupported ?? true;
    this.grant = opts.grant ?? 'allow';
    this.mimeType = opts.mimeType ?? 'audio/webm';
    this.currentTime = opts.startTime ?? 1000;
  }

  now(): number {
    return this.currentTime;
  }

  advance(ms: number): void {
    this.currentTime += ms;
  }

  async getUserMedia(): Promise<MediaStreamLike> {
    this.getUserMediaCount++;
    await Promise.resolve();
    const grant = this.grant;
    if (grant !== 'allow' && grant !== 'no-tracks' && grant !== 'ended-track') {
      throw grant.reject;
    }
    const tracks =
      grant === 'no-tracks'
        ? []
        : [new FakeTrack(grant === 'ended-track')];
    this.tracks.push(...tracks);
    const stream: MediaStreamLike = {
      getAudioTracks: () => tracks,
    };
    this.streams.push(stream);
    return stream;
  }

  createLevelGraph(): LevelGraph {
    if (this.opts.graphCtorThrows) throw new Error('audio graph failed');
    const graph = new FakeGraph(this.opts.level ?? 0.5);
    this.graphs.push(graph);
    return graph;
  }

  pickMimeType(candidates: readonly string[]): string {
    // Fake "support": the configured type is always accepted ('' = no
    // negotiable type, recorder still uses the platform default).
    void candidates;
    this.negotiatedTypes.push(this.mimeType);
    return this.mimeType;
  }

  createRecorder(): MediaRecorderLike {
    if (this.opts.recorderCtorThrows) throw new Error('no recorder');
    const recorder = new FakeRecorder({
      mimeType: this.mimeType,
      finalSize: this.opts.finalSize ?? 128,
      autoFinal: this.opts.autoFinal ?? true,
      startThrows: this.opts.recorderStartThrows ?? false,
    });
    this.recorders.push(recorder);
    return recorder;
  }

  assembleBlob(
    chunks: ReadonlyArray<{ readonly size: number }>,
  ): { readonly size: number } {
    if (this.opts.assemble === 'throw') throw new Error('assemble failed');
    const size =
      this.opts.assemble === 'empty'
        ? 0
        : chunks.reduce((acc, c) => acc + c.size, 0);
    this.assembledSizes.push(size);
    return { size };
  }

  createObjectURL(blob: { readonly size: number }): string {
    if (this.opts.createUrlThrows) throw new Error('url failed');
    const url = `blob:fake/${++this.urlSeq}?size=${blob.size}`;
    this.createdUrls.push(url);
    return url;
  }

  revokeObjectURL(url: string): void {
    this.revokedUrls.push(url);
  }

  requestFrame(cb: () => void): number {
    const handle = this.frameSeq++;
    this.handles.set(handle, cb);
    return handle;
  }

  cancelFrame(handle: number): void {
    this.handles.delete(handle);
  }

  /** Run every currently-scheduled frame callback once (rAF is one-shot). */
  flushFrames(): void {
    const cbs = [...this.handles.values()];
    this.handles.clear();
    for (const cb of cbs) cb();
  }

  get pendingFrameCount(): number {
    return this.handles.size;
  }

  get lastRecorder(): FakeRecorder | undefined {
    return this.recorders[this.recorders.length - 1];
  }
}

/** Drain n chained microtasks (fake grants / recorder events queue them). */
export async function flush(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function domException(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

export const fakeErrors = {
  notAllowed: domException('NotAllowedError'),
  notFound: domException('NotFoundError'),
  notReadable: domException('NotReadableError'),
  abort: domException('AbortError'),
  other: domException('SomethingWeird'),
};
