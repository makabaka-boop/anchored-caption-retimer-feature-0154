import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createBrowserAdapter, type MediaAdapter } from './adapter';
import {
  NarrationRecorder,
  type RecorderErrorKind,
} from './recorder';

const ERROR_TEXT: Record<RecorderErrorKind, string> = {
  UNSUPPORTED: '当前环境不支持录音（缺少 MediaRecorder 或可用封装格式）',
  PERMISSION_DENIED: '麦克风授权被拒绝',
  NO_DEVICE: '未找到可用麦克风设备',
  TRACK_ENDED: '音轨中断（设备断开或被系统回收）',
  START_FAILED: '录制启动失败',
  ENCODE_FAILED: '编码器报错',
  PACKAGE_FAILED: '封装失败',
  EMPTY_TAKE: '未采集到有效音频数据',
};

function fmtDuration(ms: number): string {
  const tenths = Math.floor(ms / 100);
  const t = tenths % 10;
  const totalSec = Math.floor(tenths / 10);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60);
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `${pad(m)}:${pad(s)}.${t}`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function NarrationPanel({
  adapter,
}: {
  adapter?: MediaAdapter;
}): JSX.Element {
  // 控制器创建是纯操作（不触碰媒体设备）；懒初始化在 ref 中，
  // StrictMode 重复渲染/重挂载都复用同一实例，不会创建并行录制器。
  const ctrlRef = useRef<NarrationRecorder | null>(null);
  if (ctrlRef.current === null) {
    ctrlRef.current = new NarrationRecorder(adapter ?? createBrowserAdapter());
  }
  const ctrl = ctrlRef.current;
  const snap = useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot);

  // 切回字幕页或卸载时幂等关闭音轨、音频图并撤销对象 URL。
  // StrictMode 会重复执行清理，teardown 幂等且绝不自行请求权限。
  useEffect(() => () => ctrl.teardown(), [ctrl]);

  // 录制期间用 rAF 刷新电平与时长；直接写 DOM 避免高频重渲染。
  // 后台限频只会降低刷新率，录制与封装由 MediaRecorder 独立完成。
  const meterRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (snap.phase !== 'recording') return;
    let raf = 0;
    const tick = (): void => {
      if (meterRef.current !== null) {
        meterRef.current.style.width = `${Math.round(ctrl.sampleLevel() * 100)}%`;
      }
      if (clockRef.current !== null) {
        clockRef.current.textContent = fmtDuration(ctrl.elapsedMs());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [snap.phase, ctrl]);

  return (
    <section className="recorder">
      <h2>现场旁白采集</h2>
      <p className="sub">
        一次旁白录制会话：启用麦克风后依次完成授权、采集、封装与复听；复听可播放成品或废弃重来。本录音台不读取字幕数据。
      </p>

      {snap.phase === 'error' && snap.error !== null && (
        <div className="banner error" role="alert">
          {snap.error.kind} — {ERROR_TEXT[snap.error.kind]}
          {snap.error.detail !== '' && (
            <span className="detail">（{snap.error.detail}）</span>
          )}
        </div>
      )}

      <div className="recorder-console">
        {snap.phase === 'idle' && (
          <>
            <p>麦克风未启用。点击「启用麦克风」开始一次旁白录制会话。</p>
            <button type="button" onClick={() => void ctrl.enableMic()}>
              启用麦克风
            </button>
          </>
        )}

        {snap.phase === 'authorizing' && (
          <p className="status">正在请求麦克风授权…</p>
        )}

        {snap.phase === 'ready' && (
          <>
            <p className="status">待录 — 麦克风已就绪，可以开始录制。</p>
            <div className="recorder-actions">
              <button type="button" onClick={() => ctrl.startRecording()}>
                开始录制
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => ctrl.teardown()}
              >
                停用麦克风
              </button>
            </div>
          </>
        )}

        {snap.phase === 'recording' && (
          <>
            <p className="status recording">
              <span className="dot" aria-hidden="true" /> 录制中 ·{' '}
              <span ref={clockRef}>00:00.0</span>
            </p>
            <div
              className="meter"
              role="meter"
              aria-label="输入电平"
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div ref={meterRef} className="meter-fill" />
            </div>
            <div className="recorder-actions">
              <button type="button" onClick={() => ctrl.stopRecording()}>
                停止录制
              </button>
            </div>
          </>
        )}

        {snap.phase === 'packaging' && (
          <p className="status">正在封装录音…</p>
        )}

        {snap.phase === 'review' && snap.take !== null && (
          <>
            <p className="status">
              复听 — 时长 {fmtDuration(snap.take.durationMs)} ·{' '}
              {fmtSize(snap.take.size)} · {snap.take.mimeType}
            </p>
            {/* 现场旁白尚无字幕轨，audio 无需 captions */}
            <audio controls src={snap.take.url} />
            <div className="recorder-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => ctrl.discardTake()}
              >
                废弃重来
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => ctrl.teardown()}
              >
                停用麦克风
              </button>
            </div>
          </>
        )}

        {snap.phase === 'error' && (
          <div className="recorder-actions">
            <button type="button" onClick={() => void ctrl.enableMic()}>
              重新启用麦克风
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
