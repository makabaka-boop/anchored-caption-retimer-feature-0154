/**
 * 旁白录制会话控制器：授权 → 待录 → 录制 → 封装 → 复听。
 *
 * 与框架无关，全部媒体调用经由注入的 MediaAdapter；React 面板只做订阅
 * 与渲染。会话号单调递增，绑定录制器、音频块与对象 URL——任何迟到事件
 * 都会因会话号过时而失效，不会覆盖新 take。
 */
import type {
  LevelMonitor,
  MediaAdapter,
  MicHandle,
  RecorderHandle,
} from './adapter';

export type PhaseKind =
  | 'idle' // 未启用
  | 'authorizing' // 请求授权
  | 'ready' // 待录
  | 'recording' // 录制
  | 'packaging' // 封装
  | 'review' // 复听
  | 'error'; // 可恢复错误

export type RecorderErrorKind =
  | 'UNSUPPORTED' // 不支持录音（无 MediaRecorder 或无可用封装格式）
  | 'PERMISSION_DENIED' // 拒绝授权
  | 'NO_DEVICE' // 无设备
  | 'TRACK_ENDED' // 音轨中断
  | 'START_FAILED' // 启动报错
  | 'ENCODE_FAILED' // 编码报错
  | 'PACKAGE_FAILED' // 封装失败
  | 'EMPTY_TAKE'; // 空数据

export interface RecorderError {
  kind: RecorderErrorKind;
  detail: string;
}

export interface Take {
  /** 生成该 take 的会话号。 */
  session: number;
  url: string;
  blob: Blob;
  mimeType: string;
  /** 单调时钟差，与动画帧无关。 */
  durationMs: number;
  size: number;
}

export interface Snapshot {
  phase: PhaseKind;
  take: Take | null;
  error: RecorderError | null;
  session: number;
}

function describe(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

/** getUserMedia 拒绝原因归类：授权问题 vs 设备问题。 */
export function classifyMicError(err: unknown): RecorderError {
  const name =
    typeof err === 'object' && err !== null && 'name' in err
      ? String((err as { name: unknown }).name)
      : '';
  const detail = describe(err);
  if (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    name === 'OverconstrainedError' ||
    name === 'NotReadableError' ||
    name === 'TrackStartError'
  ) {
    return { kind: 'NO_DEVICE', detail };
  }
  // NotAllowedError / SecurityError 及其余未知拒绝都按授权失败呈现。
  return { kind: 'PERMISSION_DENIED', detail };
}

export class NarrationRecorder {
  private readonly adapter: MediaAdapter;
  private readonly listeners = new Set<() => void>();

  private phase: PhaseKind = 'idle';
  private error: RecorderError | null = null;
  private take: Take | null = null;

  /** 单调递增会话号；每次状态迁移递增，使旧回调全部失效。 */
  private session = 0;
  private mic: MicHandle | null = null;
  private recorder: RecorderHandle | null = null;
  private monitor: LevelMonitor | null = null;
  private chunks: Blob[] = [];
  private mimeType: string | null = null;
  private startedAt = 0;

  private snapshot: Snapshot = {
    phase: 'idle',
    take: null,
    error: null,
    session: 0,
  };

  constructor(adapter: MediaAdapter) {
    this.adapter = adapter;
  }

  /** useSyncExternalStore 兼容：引用稳定的快照 + 订阅。 */
  readonly subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  readonly getSnapshot = (): Snapshot => this.snapshot;

  /** 启用麦克风：请求授权。仅在 idle / error 可进入，重复点击无效。 */
  async enableMic(): Promise<void> {
    if (this.phase !== 'idle' && this.phase !== 'error') return;
    this.error = null;
    if (!this.adapter.isSupported()) {
      this.fail({
        kind: 'UNSUPPORTED',
        detail: 'MediaRecorder / mediaDevices 不可用',
      });
      return;
    }
    const mime = this.adapter.negotiateMimeType();
    if (mime === null) {
      this.fail({
        kind: 'UNSUPPORTED',
        detail: '没有 MediaRecorder 支持的封装格式',
      });
      return;
    }
    this.mimeType = mime;
    const s = ++this.session;
    this.setPhase('authorizing');
    let mic: MicHandle;
    try {
      mic = await this.adapter.openMic();
    } catch (err) {
      if (s !== this.session) return; // 等待期间已被停用
      this.fail(classifyMicError(err));
      return;
    }
    if (s !== this.session) {
      // 授权返回得太迟：会话已废弃，立即释放这个迟到的麦克风。
      try {
        mic.stop();
      } catch {
        /* 忽略 */
      }
      return;
    }
    this.mic = mic;
    mic.onEnded(() => {
      // 仅当仍持有同一个麦克风时才算中断；旧设备的迟到事件忽略。
      if (this.mic !== mic) return;
      if (
        this.phase === 'ready' ||
        this.phase === 'recording' ||
        this.phase === 'packaging' ||
        this.phase === 'review'
      ) {
        this.fail({ kind: 'TRACK_ENDED', detail: '音轨被外部中断' });
      }
    });
    this.setPhase('ready');
  }

  /** 开始录制。仅在待录态有效；录制中重复开始被忽略。 */
  startRecording(): void {
    if (this.phase !== 'ready' || this.mic === null || this.mimeType === null) {
      return;
    }
    const mic = this.mic;
    const mimeType = this.mimeType;
    const s = ++this.session;
    this.chunks = [];
    let recorder: RecorderHandle;
    try {
      recorder = this.adapter.createRecorder(mic, mimeType, {
        onData: (chunk) => {
          if (s !== this.session) return; // 迟到事件
          if (this.phase !== 'recording' && this.phase !== 'packaging') return;
          if (chunk.size > 0) this.chunks.push(chunk);
        },
        onStop: () => {
          if (s !== this.session) return;
          if (this.phase !== 'packaging') return;
          this.finalize(s);
        },
        onError: (err) => {
          if (s !== this.session) return;
          if (this.phase !== 'recording' && this.phase !== 'packaging') return;
          this.fail({ kind: 'ENCODE_FAILED', detail: describe(err) });
        },
      });
    } catch (err) {
      this.fail({ kind: 'START_FAILED', detail: describe(err) });
      return;
    }
    this.recorder = recorder;
    // 电平采样尽力而为：音频图不可用不阻断录制。
    try {
      this.monitor = this.adapter.createLevelMonitor(mic);
    } catch {
      this.monitor = null;
    }
    try {
      recorder.start();
    } catch (err) {
      this.fail({ kind: 'START_FAILED', detail: describe(err) });
      return;
    }
    this.startedAt = this.adapter.now();
    this.setPhase('recording');
  }

  /** 停止录制，进入封装；最终 dataavailable 与 stop 到齐后才生成 take。 */
  stopRecording(): void {
    if (this.phase !== 'recording' || this.recorder === null) return;
    this.setPhase('packaging');
    try {
      this.recorder.stop();
    } catch (err) {
      this.fail({ kind: 'PACKAGE_FAILED', detail: describe(err) });
    }
  }

  /** 废弃当前 take 回到待录（重录）。 */
  discardTake(): void {
    if (this.phase !== 'review' || this.take === null) return;
    this.revokeTake();
    // 递增会话号：上一段录制的迟到事件不得影响下一次。
    this.session += 1;
    this.setPhase('ready');
  }

  /**
   * 幂等关闭：停止录制器、关闭音频图与音轨、撤销对象 URL。
   * 停止、切回字幕页、卸载共用此路径，可重复调用。
   */
  teardown(): void {
    this.releaseAll();
    this.error = null;
    this.setPhase('idle');
  }

  /** 录制中的输入电平（0..1）；非录制态或无采样器时为 0。 */
  sampleLevel(): number {
    if (this.phase !== 'recording' || this.monitor === null) return 0;
    const v = this.monitor.sample();
    if (!Number.isFinite(v)) return 0;
    return Math.min(1, Math.max(0, v));
  }

  /** 录制/封装经过时长：单调时钟差，与动画帧刷新无关。 */
  elapsedMs(): number {
    if (this.phase !== 'recording' && this.phase !== 'packaging') return 0;
    return Math.max(0, this.adapter.now() - this.startedAt);
  }

  /** 封装完成：仅当前会话收到 stop（最终 dataavailable 已先于它到达）。 */
  private finalize(s: number): void {
    const chunks = this.chunks;
    this.chunks = [];
    const size = chunks.reduce((n, c) => n + c.size, 0);
    if (size === 0) {
      this.fail({ kind: 'EMPTY_TAKE', detail: '未采集到非空音频块' });
      return;
    }
    let blob: Blob;
    let url: string;
    try {
      blob = new Blob(chunks, { type: this.mimeType ?? undefined });
      url = this.adapter.createObjectURL(blob);
    } catch (err) {
      this.fail({ kind: 'PACKAGE_FAILED', detail: describe(err) });
      return;
    }
    this.take = {
      session: s,
      url,
      blob,
      mimeType: this.mimeType ?? '',
      durationMs: Math.max(0, this.adapter.now() - this.startedAt),
      size,
    };
    // 释放本段录制资源（录制器已自行停止，只需解除引用；关闭音频图），
    // 麦克风保留以待重录。
    this.recorder = null;
    const mon = this.monitor;
    this.monitor = null;
    if (mon !== null) {
      try {
        mon.close();
      } catch {
        /* 忽略 */
      }
    }
    this.setPhase('review');
  }

  /** 进入可恢复错误：先幂等释放全部资源，再呈现错误。 */
  private fail(error: RecorderError): void {
    this.releaseAll();
    this.error = error;
    this.setPhase('error');
  }

  /** 释放全部硬件与对象资源；会话号递增使一切迟到回调失效。 */
  private releaseAll(): void {
    this.session += 1;
    const rec = this.recorder;
    this.recorder = null;
    if (rec !== null) {
      try {
        rec.stop();
      } catch {
        /* 已停止 */
      }
    }
    const mon = this.monitor;
    this.monitor = null;
    if (mon !== null) {
      try {
        mon.close();
      } catch {
        /* 忽略 */
      }
    }
    const mic = this.mic;
    this.mic = null;
    if (mic !== null) {
      try {
        mic.stop();
      } catch {
        /* 忽略 */
      }
    }
    this.revokeTake();
    this.chunks = [];
  }

  private revokeTake(): void {
    const take = this.take;
    this.take = null;
    if (take !== null) {
      try {
        this.adapter.revokeObjectURL(take.url);
      } catch {
        /* 忽略 */
      }
    }
  }

  private setPhase(phase: PhaseKind): void {
    this.phase = phase;
    this.emit();
  }

  private emit(): void {
    this.snapshot = {
      phase: this.phase,
      take: this.take,
      error: this.error,
      session: this.session,
    };
    for (const cb of [...this.listeners]) cb();
  }
}
