import { useMemo, useRef, useState } from 'react';
import { solve, DAY_MS, type Cue } from './solver/solve';
import { parseCues, toCuesJson } from './solver/cues';

interface Draft {
  cues: Cue[];
  base: number[]; // adopted starts
}

type Preview =
  | { kind: 'ready'; starts: number[]; cost: number }
  | { kind: 'infeasible' };

const ROW_H = 68;
const LIST_H = 560;

function fmtTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  const millis = ms % 1000;
  const pad = (v: number, w = 2): string => String(v).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(millis, 3)}`;
}

/**
 * Subtitle editing workspace. Kept as a standalone component so the narration
 * booth never imports or reads any cue data.
 */
export function CueEditor(): JSX.Element {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pins, setPins] = useState<Map<number, number>>(new Map());
  const [importError, setImportError] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const preview: Preview | null = useMemo(() => {
    if (!draft || importError) return null;
    const r = solve({ cues: draft.cues, base: draft.base, pins });
    return r.ok
      ? { kind: 'ready', starts: r.starts, cost: r.cost }
      : { kind: 'infeasible' };
  }, [draft, pins, importError]);

  const importText = (text: string): void => {
    const parsed = parseCues(text);
    if (!parsed.ok) {
      // Illegal import: drop the current preview, keep the last legal draft
      // and its pins untouched.
      setImportError(true);
      return;
    }
    setImportError(false);
    setPins(new Map());
    setScrollTop(0);
    setDraft({
      cues: parsed.cues,
      base: parsed.cues.map((c) => c.start),
    });
  };

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    importText(await file.text());
    if (fileRef.current) fileRef.current.value = '';
  };

  const setPin = (index: number, raw: string): void => {
    if (raw.trim() === '') {
      // Clearing the field removes the lock; entering a value re-pins.
      setPins((prev) => {
        const next = new Map(prev);
        next.delete(index);
        return next;
      });
      return;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > DAY_MS) return;
    setPins((prev) => {
      const next = new Map(prev);
      // One pin per cue; re-editing overwrites the previous value.
      next.set(index, value);
      return next;
    });
  };

  const removePin = (index: number): void => {
    setPins((prev) => {
      const next = new Map(prev);
      next.delete(index);
      return next;
    });
  };

  const adopt = (): void => {
    if (!draft || preview?.kind !== 'ready') return;
    // The adopted result becomes the baseline for the next round; pins stay
    // bound to cue indices so the operator can iterate on the same locks.
    setDraft({ cues: draft.cues, base: preview.starts });
  };

  const downloadStarts = (starts: number[]): void => {
    if (!draft) return;
    const blob = new Blob([toCuesJson(draft.cues, starts)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cues.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadAdopted = (): void => {
    if (!draft) return;
    downloadStarts(draft.base);
  };

  const visibleRange = (() => {
    if (!draft) return { from: 0, to: 0 };
    const from = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
    const to = Math.min(
      draft.cues.length,
      Math.ceil((scrollTop + LIST_H) / ROW_H) + 4,
    );
    return { from, to };
  })();

  return (
    <>
      <section className="toolbar">
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <button
          type="button"
          disabled={!draft || preview?.kind !== 'ready'}
          onClick={adopt}
        >
          采纳为新基线
        </button>
        <button type="button" disabled={!draft} onClick={downloadAdopted}>
          下载同结构 JSON
        </button>
        {draft && preview?.kind === 'ready' && (
          <button
            type="button"
            onClick={() => downloadStarts(preview.starts)}
          >
            下载预览结果
          </button>
        )}
        {draft && (
          <span className="meta">
            {draft.cues.length.toLocaleString()} 条 · 固定点 {pins.size} 个
          </span>
        )}
      </section>

      {importError && (
        <div className="banner error">
          INVALID_CUES — 导入非法，已清空预览；下方保留最近一次合法工作稿。
        </div>
      )}
      {!importError && draft && preview?.kind === 'infeasible' && (
        <div className="banner error">
          INFEASIBLE — 固定点约束不可行（检查临界冲突的固定点），已清空预览。
        </div>
      )}

      {!draft && !importError && (
        <div className="empty">
          导入根对象仅含 cues 的 JSON（1–20000 项；start 严格递增，duration
          1–60000，text 1–200 字符）。
        </div>
      )}

      {draft && (
        <>
          {preview?.kind === 'ready' && (
            <div className="banner ok">
              预览就绪 · 相对已采纳稿绝对位移总和{' '}
              {preview.cost.toLocaleString()} ms
            </div>
          )}
          <div
            className="list"
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            <div
              className="list-inner"
              style={{ height: draft.cues.length * ROW_H }}
            >
              {Array.from(
                { length: visibleRange.to - visibleRange.from },
                (_, k) => {
                  const i = visibleRange.from + k;
                  const cue = draft.cues[i];
                  const base = draft.base[i];
                  const pinned = pins.has(i);
                  const pinValue = pins.get(i);
                  const newStart =
                    preview?.kind === 'ready' ? preview.starts[i] : null;
                  const delta = newStart === null ? null : newStart - base;
                  const overlapPrev =
                    i > 0 &&
                    base < draft.base[i - 1] + draft.cues[i - 1].duration;
                  return (
                    <div
                      key={i}
                      className={
                        'row' +
                        (pinned ? ' pinned' : '') +
                        (delta !== 0 && newStart !== null ? ' moved' : '')
                      }
                      style={{
                        transform: `translateY(${i * ROW_H}px)`,
                        height: ROW_H,
                      }}
                    >
                      <div className="idx">#{i}</div>
                      <div className="times">
                        <div className="text" title={cue.text}>
                          {cue.text}
                        </div>
                        <div className="starts">
                          <span className={overlapPrev ? 'bad' : ''}>
                            基线 {fmtTime(base)}
                          </span>
                          <span className="dur">时长 {cue.duration} ms</span>
                          {newStart !== null && (
                            <span className={delta === 0 ? 'same' : 'shift'}>
                              预览 {fmtTime(newStart)}
                              {delta !== 0 && (
                                <em>
                                  {' '}
                                  {delta! > 0 ? '+' : ''}
                                  {delta}
                                </em>
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="lock">
                        <label>
                          固定起点
                          <input
                            type="number"
                            min={0}
                            max={DAY_MS}
                            step={1}
                            value={pinned ? pinValue : ''}
                            placeholder="—"
                            onChange={(e) => setPin(i, e.target.value)}
                          />
                        </label>
                        <button
                          type="button"
                          disabled={!pinned}
                          onClick={() => removePin(i)}
                        >
                          解除
                        </button>
                      </div>
                    </div>
                  );
                },
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
