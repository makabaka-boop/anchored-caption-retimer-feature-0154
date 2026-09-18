// Live narration session controller — a framework-agnostic state machine over
// an injectable NarrationMediaAdapter. React (or tests) simply subscribe.
//
// Session lifecycle (state `phase`):
//
//   idle ──enable()──▶ requesting ──grant+negotiate──▶ armed
//                        │ fail                          │ start()
//                        ▼                               ▼
//                      error ◀────────────────────── recording
//                        ▲                               │ stop()
//                        │                               ▼
//                        └──────── track/start/encode ◀ packaging
//                                                        │ final chunk + stop,
//                                                        │ non-empty blocks
//                                                        ▼
//                                                      review
//
//   review ──discard()──▶ requesting (fresh mic grant, incremented sessionId)
//   any phase ──reset()──▶ idle (mic released, take URL revoked)
//
// Invariants:
//   - enable() is the *only* path that requests permission or creates a
//     recorder; construction, initial mount and StrictMode remount never do;
//   - a strictly incrementing sessionId binds recorder, chunk array and object
//     URL; late dataavailable/stop events from a superseded session are
//     dropped and can never overwrite the current take;
//   - a take is produced only after BOTH the recorder's final dataavailable
//     (a non-empty block observed after stop was requested) and the stop event,
//     and only when the accumulated blocks are non-empty;
//   - elapsed time is the monotonic-clock difference start→stop; frame
//     callbacks refresh the meter only, so background throttling never cuts
//     the recording or alters its bytes;
//   - stop/reset/destroy are idempotent and release tracks, the audio graph and
//     object URLs exactly once.

import type {
  LevelGraph,
  MediaRecorderLike,
  MediaStreamLike,
  NarrationMediaAdapter,
} from './mediaAdapter';
import { MIME_CANDIDATES } from './mediaAdapter';

export type NarrationPhase =
  | 'idle'
  | 'requesting'
  | 'armed'
  | 'recording'
  | 'packaging'
  | 'review'
  | 'error';

export type NarrationErrorCode =
  | 'UNSUPPORTED'
  | 'PERMISSION_DENIED'
  | 'NO_DEVICE'
  | 'TRACK_ENDED'
  | 'START_FAILED'
  | 'ENCODE_FAILED'
  | 'PACKAGING_FAILED'
  | 'EMPTY_DATA';

export interface NarrationTake {
  readonly sessionId: number;
  readonly url: string;
  readonly mimeType: string;
  readonly size: number;
  readonly durationMs: number;
}

export interface NarrationState {
  readonly phase: NarrationPhase;
  readonly sessionId: number;
  readonly errorCode: NarrationErrorCode | null;
  readonly level: number; // 0..1, recording only
  readonly elapsedMs: number; // monotonic while recording, frozen afterwards
  readonly take: NarrationTake | null;
}

interface Session {
  id: number;
  stream: MediaStreamLike;
  graph: LevelGraph;
  recorder: MediaRecorderLike;
  mimeType: string;
  chunks: Array<{ size: number }>;
  startedAt: number;
  durationMs: number;
  /** stop() was requested; the next non-empty data block is the final one. */
  stopRequested: boolean;
  finalSeen: boolean;
  /** close paths already ran; further events are ignored. */
  released: boolean;
  frameHandle: number | null;
  trackEnded: boolean;
  take: NarrationTake | null;
}

export type Unsubscribe = () => void;

function mapGetUserMediaError(err: unknown): NarrationErrorCode {
  const name =
    err instanceof Error ? err.name : typeof err === 'string' ? err : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'PERMISSION_DENIED';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
    case 'NotReadableError':
    case 'TrackStartError':
      return 'NO_DEVICE';
    default:
      // AbortError and anything unknown: the device/user may recover on retry.
      return 'NO_DEVICE';
  }
}

export class NarrationRecorder {
  private readonly adapter: NarrationMediaAdapter;
  private readonly listeners = new Set<(s: NarrationState) => void>();

  private seq = 0;
  private current: Session | null = null;
  private state: NarrationState = {
    phase: 'idle',
    sessionId: 0,
    errorCode: null,
    level: 0,
    elapsedMs: 0,
    take: null,
  };

  constructor(adapter: NarrationMediaAdapter) {
    this.adapter = adapter;
  }

  getState(): NarrationState {
    return this.state;
  }

  subscribe(listener: (s: NarrationState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(patch: Partial<NarrationState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  // -- user actions --------------------------------------------------------

  /**
   * Request permission, negotiate a container, build the audio graph and arm a
   * fresh recorder under a new session id. Callable from idle, error or review
   * (review re-record first revokes the previous take URL). May be triggered
   * only by an explicit click — never by mount effects.
   */
  enable(): void {
    if (this.state.phase === 'requesting') return; // duplicate click guard
    this.disposeCurrent();

    const id = ++this.seq;
    this.emit({
      phase: 'requesting',
      sessionId: id,
      errorCode: null,
      level: 0,
      elapsedMs: 0,
      take: null,
    });

    if (!this.adapter.isSupported) {
      this.failAcquisition(id, 'UNSUPPORTED');
      return;
    }

    this.acquire(id);
  }

  private async acquire(id: number): Promise<void> {
    let stream: MediaStreamLike;
    try {
      stream = await this.adapter.getUserMedia();
    } catch (err) {
      // A late grant rejection after disable()/a newer enable() is dropped.
      if (this.seq !== id || this.state.phase !== 'requesting') return;
      this.failAcquisition(id, mapGetUserMediaError(err));
      return;
    }
    if (this.seq !== id || this.state.phase !== 'requesting') {
      // Superseded while awaiting the prompt: release the granted devices.
      this.releaseStream(stream);
      return;
    }

    const tracks = stream.getAudioTracks();
    if (tracks.length === 0 || tracks.some((t) => t.readyState === 'ended')) {
      this.releaseStream(stream);
      this.failAcquisition(id, 'NO_DEVICE');
      return;
    }

    const mimeType = this.adapter.pickMimeType(MIME_CANDIDATES);

    let graph: LevelGraph;
    try {
      graph = this.adapter.createLevelGraph(stream);
    } catch {
      this.releaseStream(stream);
      this.failAcquisition(id, 'START_FAILED');
      return;
    }

    let recorder: MediaRecorderLike;
    try {
      recorder = this.adapter.createRecorder(stream, mimeType);
    } catch {
      graph.close();
      this.releaseStream(stream);
      this.failAcquisition(id, 'UNSUPPORTED');
      return;
    }

    if (this.seq !== id || this.state.phase !== 'requesting') {
      this.detachRecorder(recorder);
      try {
        recorder.stop();
      } catch {
        // best effort
      }
      graph.close();
      this.releaseStream(stream);
      return;
    }

    const session: Session = {
      id,
      stream,
      graph,
      recorder,
      mimeType: recorder.mimeType || mimeType,
      chunks: [],
      startedAt: 0,
      durationMs: 0,
      stopRequested: false,
      finalSeen: false,
      released: false,
      frameHandle: null,
      trackEnded: false,
      take: null,
    };
    this.current = session;

    recorder.addEventListener('dataavailable', this.onData);
    recorder.addEventListener('stop', this.onStop);
    recorder.addEventListener('error', this.onRecorderError);
    for (const t of tracks) {
      t.addEventListener('ended', this.onTrackEnded);
    }

    this.emit({ phase: 'armed', elapsedMs: 0, level: 0 });
  }

  start(): void {
    const s = this.current;
    if (!s || s.released || this.state.phase !== 'armed') return;
    try {
      // No timeslice: implementations then deliver the whole buffer as one
      // final block after stop() — we still tolerate streaming variants.
      s.recorder.start();
    } catch {
      this.failSession(s, 'START_FAILED');
      return;
    }
    if (s.released || this.state.phase !== 'armed') return;
    s.startedAt = this.adapter.now();
    s.durationMs = 0;
    this.emit({ phase: 'recording', elapsedMs: 0, level: 0 });
    s.frameHandle = this.adapter.requestFrame(this.tick);
  }

  /** User stop: keep capturing until the platform drains its final block. */
  stop(): void {
    const s = this.current;
    if (!s || s.released || this.state.phase !== 'recording') return;
    // Duration is the monotonic clock delta at the stop request; rAF may be
    // paused (background tab) but the clock keeps advancing.
    s.durationMs = Math.max(0, this.adapter.now() - s.startedAt);
    s.stopRequested = true;
    this.cancelFrame(s);
    this.emit({ phase: 'packaging', level: 0, elapsedMs: s.durationMs });
    try {
      s.recorder.stop();
    } catch {
      this.failSession(s, 'ENCODE_FAILED');
    }
  }

  /** Discard the finished take and immediately arm a new recording session. */
  discard(): void {
    const s = this.current;
    // A review session has already released its hardware; only the take URL
    // is left to revoke. The phase check makes the button a no-op elsewhere.
    if (!s || this.state.phase !== 'review') return;
    // enable() disposes the current session (revoking the take URL) and runs
    // the canonical re-arm path under a new session id.
    this.enable();
  }

  /** Back to the initial panel; releases everything, revokes any take URL. */
  reset(): void {
    this.disposeCurrent();
    this.current = null;
    this.emit({
      phase: 'idle',
      errorCode: null,
      level: 0,
      elapsedMs: 0,
      take: null,
    });
  }

  /** Unmount / tab switch: idempotent full shutdown, no state notifications. */
  destroy(): void {
    this.disposeCurrent();
    this.current = null;
    // Make a grant resolving after unmount release its own stream instead of
    // touching state (checked via seq in acquire); bumping the epoch suffices.
    this.seq++;
    this.listeners.clear();
  }

  /**
   * Revoke any take URL and fully release the current session. Idempotent:
   * after a successful finalization the hardware is already gone, so only the
   * URL remains; an in-flight session is stopped and torn down.
   */
  private disposeCurrent(): void {
    const s = this.current;
    if (!s) return;
    if (s.take) this.adapter.revokeObjectURL(s.take.url);
    if (!s.released) {
      // A recording/packaging in flight is stopped first; finalization events
      // land on a released session and are ignored.
      this.teardownLive(s);
      this.releaseHardware(s);
    }
  }

  //-- internals ------------------------------------------------------------

  private tick = (): void => {
    const s = this.current;
    if (!s || s.released || this.state.phase !== 'recording') return;
    s.frameHandle = null;
    this.refreshMeter();
    // rAF stops firing in background tabs; MediaRecorder keeps capturing.
    s.frameHandle = this.adapter.requestFrame(this.tick);
  };

  /**
   * Sample the analyser and publish elapsed time. Public for tests: callers
   * may force a sample without going through the (throttled) frame loop.
   */
  refreshMeter(): void {
    const s = this.current;
    if (!s || s.released || this.state.phase !== 'recording') return;
    const level = s.graph.sampleLevel();
    this.emit({
      level: level === null ? this.state.level : level,
      elapsedMs: Math.max(0, this.adapter.now() - s.startedAt),
    });
  }

  private onData = (event: { data: { size: number } }): void => {
    const s = this.current;
    if (!s || s.released) return;
    s.chunks.push(event.data);
    if (
      s.stopRequested &&
      !s.finalSeen &&
      s.recorder.state === 'inactive' &&
      event.data.size > 0
    ) {
      s.finalSeen = true;
    }
  };

  private onStop = (): void => {
    const s = this.current;
    if (!s || s.released) return;
    if (this.state.phase !== 'packaging') {
      // Unexpected stop outside an explicit stop() — the track/platform
      // ended the capture on its own.
      if (!s.trackEnded) this.failSession(s, 'TRACK_ENDED');
      return;
    }
    if (!s.finalSeen) {
      // Recorder stopped without delivering a non-empty final block.
      this.failSession(s, 'EMPTY_DATA');
      return;
    }
    let size = 0;
    for (const c of s.chunks) size += c.size;
    if (size === 0) {
      this.failSession(s, 'EMPTY_DATA');
      return;
    }

    let blob: { size: number };
    let url: string;
    try {
      blob = this.adapter.assembleBlob(s.chunks, s.mimeType);
      url = this.adapter.createObjectURL(blob);
    } catch {
      this.failSession(s, 'PACKAGING_FAILED');
      return;
    }
    if (blob.size === 0) {
      this.adapter.revokeObjectURL(url);
      this.failSession(s, 'EMPTY_DATA');
      return;
    }

    const take: NarrationTake = {
      sessionId: s.id,
      url,
      mimeType: s.mimeType,
      size: blob.size,
      durationMs: s.durationMs,
    };
    s.take = take;
    // Capture is finished: release the mic and tear the graph now; keep only
    // the object URL alive for review.
    this.releaseHardware(s);
    this.emit({ phase: 'review', take, level: 0, elapsedMs: s.durationMs });
  };

  private onRecorderError = (): void => {
    const s = this.current;
    if (!s || s.released) return;
    // Failure while starting to capture vs. while encoding/stopping.
    const code: NarrationErrorCode =
      this.state.phase === 'armed' ? 'START_FAILED' : 'ENCODE_FAILED';
    this.failSession(s, code);
  };

  private onTrackEnded = (): void => {
    const s = this.current;
    if (!s || s.released) return;
    s.trackEnded = true;
    this.failSession(s, 'TRACK_ENDED');
  };

  private failAcquisition(
    id: number,
    code: NarrationErrorCode,
  ): void {
    if (this.seq !== id) return;
    this.current = null;
    this.emit({ phase: 'error', errorCode: code, level: 0 });
  }

  private failSession(s: Session, code: NarrationErrorCode): void {
    if (s !== this.current || s.released) return;
    if (s.take) this.adapter.revokeObjectURL(s.take.url);
    this.cancelFrame(s);
    this.teardownLive(s);
    this.releaseHardware(s);
    this.emit({
      phase: 'error',
      errorCode: code,
      level: 0,
      elapsedMs: 0,
      take: null,
    });
  }

  private cancelFrame(s: Session): void {
    if (s.frameHandle !== null) {
      this.adapter.cancelFrame(s.frameHandle);
      s.frameHandle = null;
    }
  }

  /** Stop the recorder without touching tracks (releaseHardware does that). */
  private teardownLive(s: Session): void {
    this.cancelFrame(s);
    if (s.recorder.state !== 'inactive') {
      try {
        s.recorder.stop();
      } catch {
        // already stopping
      }
    }
  }

  private detachRecorder(recorder: MediaRecorderLike): void {
    recorder.removeEventListener('dataavailable', this.onData);
    recorder.removeEventListener('stop', this.onStop);
    recorder.removeEventListener('error', this.onRecorderError);
  }

  /** Idempotent: detach listeners, stop tracks, close graph exactly once. */
  private releaseHardware(s: Session): void {
    if (s.released) return;
    s.released = true;
    this.cancelFrame(s);
    this.detachRecorder(s.recorder);
    for (const t of s.stream.getAudioTracks()) {
      t.removeEventListener('ended', this.onTrackEnded);
      if (t.readyState === 'live') {
        try {
          t.stop();
        } catch {
          // already stopped
        }
      }
    }
    s.graph.close();
  }

  private releaseStream(stream: MediaStreamLike): void {
    for (const t of stream.getAudioTracks()) {
      if (t.readyState === 'live') {
        try {
          t.stop();
        } catch {
          // already stopped
        }
      }
    }
  }
}
