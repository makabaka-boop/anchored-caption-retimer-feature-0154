/**
 * 媒体适配器：把全部平台媒体调用（getUserMedia / MediaRecorder /
 * AnalyserNode / 对象 URL / 单调时钟）收敛到一个可注入接口后面。
 * 控制器只依赖这里的类型，测试用伪适配器注入，页面用浏览器实现。
 */

/** 一次已授权的麦克风会话。底层 MediaStream 对控制器不透明。 */
export interface MicHandle {
  /** 平台 MediaStream；控制器不读取，仅回传给适配器。 */
  readonly stream: unknown;
  /** 注册音轨外部中断（设备断开/被系统回收）回调。 */
  onEnded(cb: () => void): void;
  /** 幂等关闭全部音轨；重复调用无副作用。 */
  stop(): void;
}

/** 录制器事件回调，由控制器在创建录制器时绑定会话号。 */
export interface RecorderCallbacks {
  onData(chunk: Blob): void;
  onStop(): void;
  onError(error: unknown): void;
}

export interface RecorderHandle {
  /** 可能抛错（启动失败）。 */
  start(): void;
  /** 幂等；在非录制态调用不得抛错。 */
  stop(): void;
}

/** 输入电平采样器（AnalyserNode 封装）。创建失败时录制照常进行。 */
export interface LevelMonitor {
  /** 当前输入电平，0..1。 */
  sample(): number;
  /** 幂等关闭音频图。 */
  close(): void;
}

export interface MediaAdapter {
  /** 平台是否具备录音能力（mediaDevices + MediaRecorder）。 */
  isSupported(): boolean;
  /** 协商 MediaRecorder 支持的封装格式；都不支持返回 null。 */
  negotiateMimeType(): string | null;
  /** 请求麦克风授权；拒绝/无设备等以异常拒绝。 */
  openMic(): Promise<MicHandle>;
  /** 基于已授权麦克风创建录制器；可能抛错。 */
  createRecorder(
    mic: MicHandle,
    mimeType: string,
    cb: RecorderCallbacks,
  ): RecorderHandle;
  /** 创建电平采样器；平台不支持音频图时返回 null。 */
  createLevelMonitor(mic: MicHandle): LevelMonitor | null;
  /** 单调时钟（performance.now），时长只能取它的差值。 */
  now(): number;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

/** 候选封装格式，按优先级依次探测。 */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

/** 浏览器环境适配器；仅在本模块函数被调用时触碰平台 API。 */
export function createBrowserAdapter(): MediaAdapter {
  return {
    isSupported: () =>
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function' &&
      typeof MediaRecorder !== 'undefined',

    negotiateMimeType: () => {
      for (const mime of MIME_CANDIDATES) {
        try {
          if (MediaRecorder.isTypeSupported(mime)) return mime;
        } catch {
          // 个别实现对异常格式抛错，视为不支持继续探测。
        }
      }
      return null;
    },

    openMic: async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const tracks = stream.getAudioTracks();
      const listeners = new Set<() => void>();
      let stopped = false;
      const onEnded = (): void => {
        if (stopped) return;
        for (const cb of [...listeners]) cb();
      };
      for (const t of tracks) t.addEventListener('ended', onEnded);
      return {
        stream,
        onEnded: (cb) => {
          listeners.add(cb);
        },
        stop: () => {
          if (stopped) return;
          stopped = true;
          listeners.clear();
          for (const t of tracks) {
            // 先摘监听再停轨：即使某实现停轨触发 ended 也不会误报。
            try {
              t.removeEventListener('ended', onEnded);
            } catch {
              /* 忽略 */
            }
            try {
              t.stop();
            } catch {
              /* 忽略 */
            }
          }
        },
      };
    },

    createRecorder: (mic, mimeType, cb) => {
      const rec = new MediaRecorder(mic.stream as MediaStream, { mimeType });
      rec.ondataavailable = (e: BlobEvent): void => {
        if (e.data && e.data.size > 0) cb.onData(e.data);
      };
      rec.onstop = (): void => cb.onStop();
      rec.onerror = (e: Event): void =>
        cb.onError((e as ErrorEvent).error ?? e);
      return {
        start: () => rec.start(),
        stop: () => {
          // 幂等停止：已停止的录制器再次 stop 会抛 InvalidStateError。
          if (rec.state !== 'inactive') rec.stop();
        },
      };
    },

    createLevelMonitor: (mic) => {
      const Ctor =
        typeof window !== 'undefined'
          ? window.AudioContext ??
            (window as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext
          : undefined;
      if (!Ctor) return null;
      const ctx = new Ctor();
      const source = ctx.createMediaStreamSource(mic.stream as MediaStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let closed = false;
      return {
        sample: () => {
          if (closed) return 0;
          analyser.getFloatTimeDomainData(buf);
          let peak = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = Math.abs(buf[i]);
            if (v > peak) peak = v;
          }
          return Math.min(1, peak);
        },
        close: () => {
          if (closed) return;
          closed = true;
          try {
            source.disconnect();
          } catch {
            /* 忽略 */
          }
          try {
            analyser.disconnect();
          } catch {
            /* 忽略 */
          }
          void ctx.close().catch(() => {
            /* 忽略 */
          });
        },
      };
    },

    now: () => performance.now(),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  };
}
