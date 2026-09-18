import type { NarrationErrorCode } from './NarrationRecorder';

export const ERROR_TEXT: Record<NarrationErrorCode, string> = {
  UNSUPPORTED:
    '当前浏览器不支持麦克风录音（缺少 MediaRecorder / getUserMedia），请更换现代浏览器后重试。',
  PERMISSION_DENIED:
    '麦克风授权被拒绝。可在浏览器地址栏的站点权限中重新允许麦克风，然后重试。',
  NO_DEVICE:
    '未找到可用麦克风或设备被占用。请确认麦克风已连接且未被其他程序占用，然后重试。',
  TRACK_ENDED:
    '录音过程中音轨意外中断。请检查麦克风连接，然后重试。',
  START_FAILED:
    '录音启动失败。设备可能刚刚被占用，请重试。',
  ENCODE_FAILED:
    '音频编码出错，未能完成录制。请重试本条旁白。',
  PACKAGING_FAILED:
    '录音封装失败，无法生成可试听的成品。请重试本条旁白。',
  EMPTY_DATA:
    '没有采集到任何音频数据（空录音）。请确认麦克风有输入后重试。',
};

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const m = Math.floor(total / 60_000);
  const s = Math.floor((total % 60_000) / 1_000);
  const tenths = Math.floor((total % 1_000) / 100);
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `${pad(m)}:${pad(s)}.${tenths}`;
}
