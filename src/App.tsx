import { useState } from 'react';
import { CueEditor } from './CueEditor';
import { NarrationConsole } from './narration/NarrationConsole';

type Tab = 'cues' | 'narration';

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'cues', label: '字幕编辑' },
  { key: 'narration', label: '现场旁白采集' },
];

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('cues');

  return (
    <div className="page">
      <header>
        <h1>字幕固定与去重叠</h1>
        <p className="sub">
          锁定少数字幕起点，求解器令固定项精确命中、全天内相邻不重叠，最小化相对已采纳稿的绝对位移总和；或切换到现场旁白采集，独立完成麦克风授权、录制、封装与复听。
        </p>
      </header>

      <nav className="tabs" role="tablist" aria-label="工作区切换">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={'tab' + (tab === t.key ? ' active' : '')}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/*
        The subtitle workspace stays mounted (hidden only) so an imported draft
        survives tab switches. The narration booth is mounted on demand:
        leaving it runs its unmount cleanup, which stops tracks, closes the
        audio graph and revokes the take URL.
      */}
      <div hidden={tab !== 'cues'}>
        <CueEditor />
      </div>
      {tab === 'narration' && <NarrationConsole />}
    </div>
  );
}
