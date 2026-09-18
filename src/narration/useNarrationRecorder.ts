import { useEffect, useRef, useState } from 'react';
import {
  NarrationRecorder,
  type NarrationState,
} from './NarrationRecorder';
import type { NarrationMediaAdapter } from './mediaAdapter';

const INITIAL_STATE: NarrationState = {
  phase: 'idle',
  sessionId: 0,
  errorCode: null,
  level: 0,
  elapsedMs: 0,
  take: null,
};

export interface NarrationApi {
  state: NarrationState;
  enable: () => void;
  start: () => void;
  stop: () => void;
  discard: () => void;
  reset: () => void;
  refreshMeter: () => void;
}

/**
 * Owns one NarrationRecorder per mounted booth.
 *
 * Permission is never requested here: the effect only constructs and destroys
 * the controller (both idle-side-effect free). Under React 18 StrictMode the
 * mount effect runs setup → cleanup → setup: the first controller is destroyed
 * before the second is created, so no parallel recorders exist and neither
 * construction calls getUserMedia. Unmounting (also used when switching back
 * to the subtitle page) destroys the active session, releasing tracks and the
 * audio graph and revoking any take URL.
 */
export function useNarrationRecorder(
  adapter: NarrationMediaAdapter,
): NarrationApi {
  const [state, setState] = useState<NarrationState>(INITIAL_STATE);
  const recorderRef = useRef<NarrationRecorder | null>(null);

  useEffect(() => {
    const recorder = new NarrationRecorder(adapter);
    recorderRef.current = recorder;
    setState(recorder.getState());
    const unsubscribe = recorder.subscribe(setState);
    return () => {
      unsubscribe();
      recorder.destroy();
      recorderRef.current = null;
    };
  }, [adapter]);

  return {
    state,
    enable: () => recorderRef.current?.enable(),
    start: () => recorderRef.current?.start(),
    stop: () => recorderRef.current?.stop(),
    discard: () => recorderRef.current?.discard(),
    reset: () => recorderRef.current?.reset(),
    refreshMeter: () => recorderRef.current?.refreshMeter(),
  };
}
