import { useMemo } from 'react';
import { createBrowserAdapter } from './browserAdapter';
import { useNarrationRecorder } from './useNarrationRecorder';
import type { NarrationMediaAdapter } from './mediaAdapter';
import type { NarrationPhase } from './NarrationRecorder';
import { ERROR_TEXT, formatDuration } from './labels';

const STEPS: Array<{ key: NarrationPhase; label: string }> = [
  { key: 'requesting', label: '请求授权' },
  { key: 'armed', label: '待录' },
  { key: 'recording', label: '录制' },
  { key: 'packaging', label: '封装' },
  { key: 'review', label: '复听' },
];

function stepIndex(phase: NarrationPhase): number {
  const i = STEPS.findIndex((s) => s.key === phase);
  return i;
}

interface NarrationConsoleProps {
  /** Production injects the real browser adapter; tests a fake one. */
  adapter?: NarrationMediaAdapter;
}

/**
 * Live narration booth. Fully independent of the subtitle editor: it neither
 * imports nor reads any cue data — its only input is the microphone.
 */
export function NarrationConsole({
  adapter,
}: NarrationConsoleProps): JSX.Element {
  // The adapter is a stable module-level singleton in production; useMemo
  // guarantees the hook's effect does not recreate controllers on re-render.
  const media = useMemo(() => adapter ?? createBrowserAdapter(), [adapter]);
  const { state, enable, start, stop, discard, reset } =
    useNarrationRecorder(media);
  const { phase, errorCode, level, elapsedMs, take } = state;

  const activeStep = stepIndex(phase);
  const busy = phase === 'requesting' || phase === 'packaging';

  return (
    <div className="booth">
      <ol className="steps">
        {STEPS.map((s, i) => (
          <li
            key={s.key}
            className={
              i === activeStep
                ? 'current'
                : activeStep >= 0 && i < activeStep
                  ? 'done'
                  : ''
            }
          >
            <span className="dot" />
            {s.label}
          </li>
        ))}
      </ol>

      <div className="booth-panel">
        {phase === 'idle' && (
          <div className="booth-idle">
            <p>
              现场旁白采集使用独立的麦克风会话，不读取任何字幕数据。点击下方
              按钮由你主动授权麦克风后开始。
            </p>
            <button type="button" className="primary" onClick={enable}>
              启用麦克风
            </button>
          </div>
        )}

        {phase === 'requesting' && (
          <div className="booth-status">
            <span className="spinner" aria-hidden="true" />
            正在请求麦克风授权…
          </div>
        )}

        {(phase === 'armed' ||
          phase === 'recording' ||
          phase === 'packaging') && (
          <div className="booth-rec">
            <div className="rec-readout">
              <span
                className={
                  'rec-dot' + (phase === 'recording' ? ' live' : '')
                }
                aria-hidden="true"
              />
              <span className="rec-time">{formatDuration(elapsedMs)}</span>
              {phase === 'armed' && <span className="rec-hint">待录</span>}
              {phase === 'recording' && (
                <span className="rec-hint">正在录制</span>
              )}
              {phase === 'packaging' && (
                <span className="rec-hint">封装中…</span>
              )}
            </div>
            <div
              className="meter"
              aria-label="输入电平"
              aria-valuenow={Math.round(level * 100)}
              role="progressbar"
            >
              <div
                className="meter-fill"
                style={{
                  width: `${Math.round(level * 100)}%`,
                }}
              />
            </div>
            <div className="rec-actions">
              {phase === 'armed' && (
                <button type="button" className="primary" onClick={start}>
                  开始录制
                </button>
              )}
              {phase === 'recording' && (
                <button type="button" className="danger" onClick={stop}>
                  停止
                </button>
              )}
              {phase === 'packaging' && (
                <button type="button" disabled>
                  封装中…
                </button>
              )}
              {!busy && (
                <button type="button" onClick={reset}>
                  取消
                </button>
              )}
            </div>
          </div>
        )}

        {phase === 'review' && take && (
          <div className="booth-review">
            <p className="review-title">本条旁白已就绪，请复听确认：</p>
            <audio className="review-player" controls src={take.url} />
            <dl className="review-meta">
              <dt>时长</dt>
              <dd>{formatDuration(take.durationMs)}</dd>
              <dt>大小</dt>
              <dd>{take.size.toLocaleString()} B</dd>
              <dt>格式</dt>
              <dd>{take.mimeType || '平台默认'}</dd>
            </dl>
            <div className="rec-actions">
              <button type="button" className="danger" onClick={discard}>
                废弃重来
              </button>
              <button type="button" onClick={reset}>
                完成，关闭麦克风
              </button>
            </div>
          </div>
        )}

        {phase === 'error' && errorCode && (
          <div className="booth-error">
            <p className="error-code">{errorCode}</p>
            <p className="error-msg">{ERROR_TEXT[errorCode]}</p>
            <div className="rec-actions">
              <button type="button" className="primary" onClick={enable}>
                重试
              </button>
              <button type="button" onClick={reset}>
                返回
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
