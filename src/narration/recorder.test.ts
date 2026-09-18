import { describe, it, expect } from 'vitest';
import { NarrationRecorder } from './recorder';
import type {
  LevelMonitor,
  MediaAdapter,
  MicHandle,
  RecorderCallbacks,
  RecorderHandle,
} from './adapter';

/* ---------------- 伪媒体适配器 ---------------- */

class FakeMic implements MicHandle {
  readonly stream = { kind: 'fake-stream' };
  private readonly listeners = new Set<() => void>();
  stopCalls = 0;
  onEnded(cb: () => void): void {
    this.listeners.add(cb);
  }
  stop(): void {
    this.stopCalls += 1;
    this.listeners.clear();
  }
  emitEnded(): void {
    for (const cb of [...this.listeners]) cb();
  }
}

class FakeRecorder implements RecorderHandle {
  startCalls = 0;
  stopCalls = 0;
  throwOnStart: unknown = null;
  constructor(private readonly cb: RecorderCallbacks) {}
  start(): void {
    this.startCalls += 1;
    if (this.throwOnStart !== null) throw this.throwOnStart;
  }
  stop(): void {
    this.stopCalls += 1;
  }
  emitData(chunk: Blob): void {
    this.cb.onData(chunk);
  }
  emitStop(): void {
    this.cb.onStop();
  }
  emitError(err: unknown): void {
    this.cb.onError(err);
  }
}

class FakeMonitor implements LevelMonitor {
  level = 0;
  closeCalls = 0;
  sample(): number {
    return this.level;
  }
  close(): void {
    this.closeCalls += 1;
  }
}

class FakeAdapter implements MediaAdapter {
  supported = true;
  mime: string | null = 'audio/webm;codecs=opus';
  openMicError: unknown = null;
  startError: unknown = null;
  throwOnCreateUrl = false;
  time = 1_000;
  readonly mics: FakeMic[] = [];
  readonly recorders: FakeRecorder[] = [];
  readonly monitors: FakeMonitor[] = [];
  readonly createdUrls: string[] = [];
  readonly revokedUrls: string[] = [];
  private urlSeq = 0;

  isSupported(): boolean {
    return this.supported;
  }
  negotiateMimeType(): string | null {
    return this.mime;
  }
  openMic(): Promise<MicHandle> {
    if (this.openMicError !== null) return Promise.reject(this.openMicError);
    const mic = new FakeMic();
    this.mics.push(mic);
    return Promise.resolve(mic);
  }
  createRecorder(
    _mic: MicHandle,
    _mimeType: string,
    cb: RecorderCallbacks,
  ): RecorderHandle {
    const rec = new FakeRecorder(cb);
    rec.throwOnStart = this.startError;
    this.recorders.push(rec);
    return rec;
  }
  createLevelMonitor(_mic: MicHandle): LevelMonitor {
    const mon = new FakeMonitor();
    this.monitors.push(mon);
    return mon;
  }
  now(): number {
    return this.time;
  }
  createObjectURL(_blob: Blob): string {
    if (this.throwOnCreateUrl) throw new Error('createObjectURL boom');
    const url = `fake://take/${(this.urlSeq += 1)}`;
    this.createdUrls.push(url);
    return url;
  }
  revokeObjectURL(url: string): void {
    this.revokedUrls.push(url);
  }
}

function blob(text: string): Blob {
  return new Blob([text]);
}

function last<T>(xs: T[]): T {
  return xs[xs.length - 1];
}

async function toReady(adapter: FakeAdapter): Promise<NarrationRecorder> {
  const ctrl = new NarrationRecorder(adapter);
  await ctrl.enableMic();
  expect(ctrl.getSnapshot().phase).toBe('ready');
  return ctrl;
}

/** 驱动一次完整录制到复听，返回当前录制器。 */
function recordToReview(
  adapter: FakeAdapter,
  ctrl: NarrationRecorder,
  chunks: string[],
): FakeRecorder {
  ctrl.startRecording();
  const rec = last(adapter.recorders);
  for (const c of chunks) rec.emitData(blob(c));
  ctrl.stopRecording();
  rec.emitStop();
  expect(ctrl.getSnapshot().phase).toBe('review');
  return rec;
}

/* ---------------- 初始状态与授权 ---------------- */

describe('初始状态与授权', () => {
  it('构造与清理不触碰媒体设备（初次展示 / StrictMode 重挂载安全）', async () => {
    const adapter = new FakeAdapter();
    const ctrl = new NarrationRecorder(adapter);
    expect(ctrl.getSnapshot().phase).toBe('idle');
    // StrictMode 挂载即清理：不得请求权限、不得创建录制器
    ctrl.teardown();
    ctrl.teardown();
    expect(adapter.mics).toHaveLength(0);
    expect(adapter.recorders).toHaveLength(0);
    expect(adapter.monitors).toHaveLength(0);
    // 清理之后仍可正常启用（重挂载复用同一控制器）
    await ctrl.enableMic();
    expect(ctrl.getSnapshot().phase).toBe('ready');
    expect(adapter.mics).toHaveLength(1);
  });

  it('启用麦克风后状态依次为请求授权、待录', async () => {
    const adapter = new FakeAdapter();
    const ctrl = new NarrationRecorder(adapter);
    const seen: string[] = [];
    ctrl.subscribe(() => seen.push(ctrl.getSnapshot().phase));
    const p = ctrl.enableMic();
    expect(ctrl.getSnapshot().phase).toBe('authorizing');
    await p;
    expect(ctrl.getSnapshot().phase).toBe('ready');
    expect(seen).toEqual(['authorizing', 'ready']);
    expect(adapter.mics).toHaveLength(1);
  });

  it('授权进行中重复启用不会创建并行请求', async () => {
    const adapter = new FakeAdapter();
    const ctrl = new NarrationRecorder(adapter);
    await Promise.all([ctrl.enableMic(), ctrl.enableMic(), ctrl.enableMic()]);
    expect(adapter.mics).toHaveLength(1);
    expect(ctrl.getSnapshot().phase).toBe('ready');
  });

  it('授权等待中卸载：迟到的麦克风被立即释放', async () => {
    const adapter = new FakeAdapter();
    let resolveMic!: (m: MicHandle) => void;
    adapter.openMic = () =>
      new Promise<MicHandle>((resolve) => {
        resolveMic = resolve;
      });
    const ctrl = new NarrationRecorder(adapter);
    const p = ctrl.enableMic();
    expect(ctrl.getSnapshot().phase).toBe('authorizing');
    ctrl.teardown();
    const late = new FakeMic();
    resolveMic(late);
    await p;
    expect(late.stopCalls).toBe(1);
    expect(ctrl.getSnapshot().phase).toBe('idle');
  });
});

/* ---------------- 录制会话 ---------------- */

describe('录制会话', () => {
  it('重复开始被忽略，只创建一个录制器', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    ctrl.startRecording();
    ctrl.startRecording();
    ctrl.startRecording();
    expect(adapter.recorders).toHaveLength(1);
    expect(last(adapter.recorders).startCalls).toBe(1);
    expect(ctrl.getSnapshot().phase).toBe('recording');
    // 录制中重复启用麦克风同样无效
    await ctrl.enableMic();
    expect(adapter.mics).toHaveLength(1);
    expect(ctrl.getSnapshot().phase).toBe('recording');
  });

  it('停止尾块进入 take；收到 stop 事件才封装；时长取单调时钟差', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    ctrl.startRecording();
    const rec = last(adapter.recorders);
    rec.emitData(blob('aaaa'));
    adapter.time = 1_600;
    ctrl.stopRecording();
    expect(ctrl.getSnapshot().phase).toBe('packaging');
    rec.emitData(blob('bb')); // stop() 之后的最终 dataavailable（尾块）
    // 仅 dataavailable 不生成 take，必须等到 stop 事件
    expect(ctrl.getSnapshot().phase).toBe('packaging');
    expect(ctrl.getSnapshot().take).toBeNull();
    rec.emitStop();
    const snap = ctrl.getSnapshot();
    expect(snap.phase).toBe('review');
    expect(snap.take).not.toBeNull();
    expect(snap.take!.size).toBe(6);
    expect(snap.take!.durationMs).toBe(600); // 单调时钟差，与帧刷新无关
    expect(snap.take!.mimeType).toBe('audio/webm;codecs=opus');
    expect(await snap.take!.blob.text()).toBe('aaaabb');
    expect(adapter.createdUrls).toHaveLength(1);
    // 封装完成：音频图关闭，录制器解除引用，麦克风保留待重录
    expect(last(adapter.monitors).closeCalls).toBe(1);
    expect(adapter.mics[0].stopCalls).toBe(0);
  });

  it('空块不计入；stop 事件后迟到的 dataavailable 被忽略', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    ctrl.startRecording();
    const rec = last(adapter.recorders);
    rec.emitData(blob('')); // 空块忽略
    rec.emitData(blob('data'));
    ctrl.stopRecording();
    rec.emitStop();
    const take = ctrl.getSnapshot().take!;
    expect(take.size).toBe(4);
    // 已复听：同会话迟到的块不得再改变成品
    rec.emitData(blob('LATE'));
    expect(ctrl.getSnapshot().take!.size).toBe(4);
  });

  it('重复停止只触发一次底层 stop', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    ctrl.startRecording();
    const rec = last(adapter.recorders);
    rec.emitData(blob('data'));
    ctrl.stopRecording();
    ctrl.stopRecording();
    expect(rec.stopCalls).toBe(1);
    rec.emitStop();
    expect(ctrl.getSnapshot().phase).toBe('review');
  });

  it('录制期间电平来自采样器并被钳制，其余状态为 0', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    expect(ctrl.sampleLevel()).toBe(0);
    ctrl.startRecording();
    const mon = last(adapter.monitors);
    mon.level = 0.7;
    expect(ctrl.sampleLevel()).toBe(0.7);
    mon.level = 5;
    expect(ctrl.sampleLevel()).toBe(1);
    ctrl.stopRecording();
    expect(ctrl.sampleLevel()).toBe(0);
  });

  it('录制中经过时长取单调时钟差', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    expect(ctrl.elapsedMs()).toBe(0);
    ctrl.startRecording();
    adapter.time = 1_250;
    expect(ctrl.elapsedMs()).toBe(250);
    adapter.time = 2_000;
    expect(ctrl.elapsedMs()).toBe(1_000);
  });
});

/* ---------------- 断连 ---------------- */

describe('音轨中断', () => {
  it('录制中断连：可恢复错误并释放全部资源', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    ctrl.startRecording();
    adapter.mics[0].emitEnded();
    const snap = ctrl.getSnapshot();
    expect(snap.phase).toBe('error');
    expect(snap.error?.kind).toBe('TRACK_ENDED');
    expect(adapter.mics[0].stopCalls).toBe(1);
    expect(last(adapter.monitors).closeCalls).toBe(1);
    expect(last(adapter.recorders).stopCalls).toBe(1);
    // 可恢复：重新启用获得新麦克风
    await ctrl.enableMic();
    expect(ctrl.getSnapshot().phase).toBe('ready');
    expect(adapter.mics).toHaveLength(2);
  });

  it('待录时断连同样报错；旧设备的迟到 ended 被忽略', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    adapter.mics[0].emitEnded();
    expect(ctrl.getSnapshot().phase).toBe('error');
    expect(ctrl.getSnapshot().error?.kind).toBe('TRACK_ENDED');
    await ctrl.enableMic();
    expect(ctrl.getSnapshot().phase).toBe('ready');
    // 旧麦克风已停，其迟到 ended 不得影响新会话
    adapter.mics[0].emitEnded();
    expect(ctrl.getSnapshot().phase).toBe('ready');
  });
});

/* ---------------- 重录交错 ---------------- */

describe('重录交错', () => {
  it('旧会话的迟到事件不得覆盖新 take', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);

    // 第一段：old-tail
    ctrl.startRecording();
    const rec1 = adapter.recorders[0];
    rec1.emitData(blob('old-'));
    ctrl.stopRecording();
    rec1.emitData(blob('tail'));
    rec1.emitStop();
    const take1 = ctrl.getSnapshot().take!;
    expect(ctrl.getSnapshot().phase).toBe('review');

    // 废弃重来：旧 URL 撤销，回到待录
    ctrl.discardTake();
    expect(ctrl.getSnapshot().phase).toBe('ready');
    expect(adapter.revokedUrls).toEqual([take1.url]);

    // 第二段开始，会话号递增
    ctrl.startRecording();
    const rec2 = adapter.recorders[1];
    rec2.emitData(blob('new-data'));

    // 旧录制器的迟到事件：不得截断、不得报错、不得生成 take
    rec1.emitData(blob('STALE'));
    rec1.emitStop();
    rec1.emitError(new Error('stale error'));
    expect(ctrl.getSnapshot().phase).toBe('recording');
    expect(ctrl.getSnapshot().take).toBeNull();

    ctrl.stopRecording();
    rec2.emitStop();
    const take2 = ctrl.getSnapshot().take!;
    expect(ctrl.getSnapshot().phase).toBe('review');
    expect(take2.session).toBeGreaterThan(take1.session);
    expect(take2.url).not.toBe(take1.url);
    expect(await take2.blob.text()).toBe('new-data');
    // 旧 URL 只撤销过一次，新 URL 未撤销
    expect(adapter.revokedUrls).toEqual([take1.url]);
    expect(adapter.createdUrls).toHaveLength(2);
  });

  it('复听中旧录制器的迟到 stop 不得破坏当前 take', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    const rec1 = recordToReview(adapter, ctrl, ['first']);
    const take1 = ctrl.getSnapshot().take!;
    // 同一录制器再发迟到事件（此前 stop 已消费）
    rec1.emitData(blob('X'));
    rec1.emitStop();
    expect(ctrl.getSnapshot().take!.url).toBe(take1.url);
    expect(adapter.revokedUrls).toHaveLength(0);
  });
});

/* ---------------- 卸载清理 ---------------- */

describe('卸载清理', () => {
  it('录制中卸载：幂等关闭音轨与音频图，重复清理无额外副作用', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    ctrl.startRecording();
    ctrl.teardown();
    expect(ctrl.getSnapshot().phase).toBe('idle');
    expect(adapter.mics[0].stopCalls).toBe(1);
    expect(last(adapter.monitors).closeCalls).toBe(1);
    expect(adapter.recorders[0].stopCalls).toBe(1);
    ctrl.teardown();
    ctrl.teardown();
    expect(adapter.mics[0].stopCalls).toBe(1);
    expect(last(adapter.monitors).closeCalls).toBe(1);
    expect(adapter.recorders[0].stopCalls).toBe(1);
    // 卸载后迟到事件无任何效果
    adapter.recorders[0].emitData(blob('x'));
    adapter.recorders[0].emitStop();
    expect(ctrl.getSnapshot().phase).toBe('idle');
    expect(ctrl.getSnapshot().take).toBeNull();
    expect(adapter.createdUrls).toHaveLength(0);
  });

  it('复听时卸载：撤销对象 URL 并关闭音轨', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    recordToReview(adapter, ctrl, ['take']);
    const url = ctrl.getSnapshot().take!.url;
    ctrl.teardown();
    expect(adapter.revokedUrls).toEqual([url]);
    expect(ctrl.getSnapshot().take).toBeNull();
    expect(adapter.mics[0].stopCalls).toBe(1);
    expect(ctrl.getSnapshot().phase).toBe('idle');
  });

  it('封装中卸载：迟到的 stop 不得生成 take', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    ctrl.startRecording();
    const rec = last(adapter.recorders);
    rec.emitData(blob('data'));
    ctrl.stopRecording();
    expect(ctrl.getSnapshot().phase).toBe('packaging');
    ctrl.teardown();
    rec.emitData(blob('tail'));
    rec.emitStop();
    expect(ctrl.getSnapshot().phase).toBe('idle');
    expect(ctrl.getSnapshot().take).toBeNull();
    expect(adapter.createdUrls).toHaveLength(0);
  });
});

/* ---------------- 可恢复错误 ---------------- */

describe('可恢复错误', () => {
  it('不支持录音（无 MediaRecorder）', async () => {
    const adapter = new FakeAdapter();
    adapter.supported = false;
    const ctrl = new NarrationRecorder(adapter);
    await ctrl.enableMic();
    expect(ctrl.getSnapshot().phase).toBe('error');
    expect(ctrl.getSnapshot().error?.kind).toBe('UNSUPPORTED');
    expect(adapter.mics).toHaveLength(0);
  });

  it('不支持录音（无可用封装格式）', async () => {
    const adapter = new FakeAdapter();
    adapter.mime = null;
    const ctrl = new NarrationRecorder(adapter);
    await ctrl.enableMic();
    expect(ctrl.getSnapshot().error?.kind).toBe('UNSUPPORTED');
    expect(adapter.mics).toHaveLength(0);
  });

  it('拒绝授权', async () => {
    const adapter = new FakeAdapter();
    adapter.openMicError = new DOMException('denied', 'NotAllowedError');
    const ctrl = new NarrationRecorder(adapter);
    await ctrl.enableMic();
    expect(ctrl.getSnapshot().error?.kind).toBe('PERMISSION_DENIED');
    // 可恢复：用户再次尝试
    adapter.openMicError = null;
    await ctrl.enableMic();
    expect(ctrl.getSnapshot().phase).toBe('ready');
  });

  it('无设备', async () => {
    const adapter = new FakeAdapter();
    adapter.openMicError = new DOMException('no mic', 'NotFoundError');
    const ctrl = new NarrationRecorder(adapter);
    await ctrl.enableMic();
    expect(ctrl.getSnapshot().error?.kind).toBe('NO_DEVICE');
  });

  it('启动报错', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    adapter.startError = new Error('start boom');
    ctrl.startRecording();
    expect(ctrl.getSnapshot().phase).toBe('error');
    expect(ctrl.getSnapshot().error?.kind).toBe('START_FAILED');
    expect(adapter.mics[0].stopCalls).toBe(1);
    // 恢复后重录成功
    adapter.startError = null;
    await ctrl.enableMic();
    recordToReview(adapter, ctrl, ['ok']);
    expect(ctrl.getSnapshot().take).not.toBeNull();
  });

  it('编码报错', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    ctrl.startRecording();
    last(adapter.recorders).emitError(new Error('encode boom'));
    expect(ctrl.getSnapshot().phase).toBe('error');
    expect(ctrl.getSnapshot().error?.kind).toBe('ENCODE_FAILED');
    expect(adapter.mics[0].stopCalls).toBe(1);
  });

  it('空数据', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    ctrl.startRecording();
    const rec = last(adapter.recorders);
    rec.emitData(blob('')); // 只有空块
    ctrl.stopRecording();
    rec.emitStop();
    expect(ctrl.getSnapshot().phase).toBe('error');
    expect(ctrl.getSnapshot().error?.kind).toBe('EMPTY_TAKE');
    expect(adapter.createdUrls).toHaveLength(0);
  });

  it('封装失败', async () => {
    const adapter = new FakeAdapter();
    const ctrl = await toReady(adapter);
    adapter.throwOnCreateUrl = true;
    ctrl.startRecording();
    const rec = last(adapter.recorders);
    rec.emitData(blob('data'));
    ctrl.stopRecording();
    rec.emitStop();
    expect(ctrl.getSnapshot().phase).toBe('error');
    expect(ctrl.getSnapshot().error?.kind).toBe('PACKAGE_FAILED');
    expect(adapter.createdUrls).toHaveLength(0);
    expect(adapter.mics[0].stopCalls).toBe(1);
  });
});
