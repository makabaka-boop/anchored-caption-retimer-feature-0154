import { describe, expect, it } from 'vitest';
import { NarrationRecorder } from './NarrationRecorder';
import {
  FakeMediaAdapter,
  FakeRecorder,
  fakeErrors,
  flush,
} from './fakeMediaAdapter';

async function armed(opts: ConstructorParameters<typeof FakeMediaAdapter>[0]) {
  const adapter = new FakeMediaAdapter(opts);
  const rec = new NarrationRecorder(adapter);
  rec.enable();
  expect(rec.getState().phase).toBe('requesting');
  await flush();
  expect(rec.getState().phase).toBe('armed');
  return { adapter, rec };
}

async function recorded(opts: ConstructorParameters<typeof FakeMediaAdapter>[0] = {}) {
  const { adapter, rec } = await armed(opts);
  rec.start();
  expect(rec.getState().phase).toBe('recording');
  adapter.advance(1500);
  rec.stop();
  expect(rec.getState().phase).toBe('packaging');
  await flush();
  expect(rec.getState().phase).toBe('review');
  return { adapter, rec };
}

describe('enable / permission', () => {
  it('never requests permission on construction or before enable()', () => {
    const adapter = new FakeMediaAdapter();
    const rec = new NarrationRecorder(adapter);
    expect(adapter.getUserMediaCount).toBe(0);
    expect(rec.getState().phase).toBe('idle');
    rec.enable();
    expect(adapter.getUserMediaCount).toBe(1);
  });

  it('StrictMode-style mount/unmount/remount never prompts or makes parallel recorders', async () => {
    // Mirrors the React 18 dev double-invoke: construct → destroy → construct.
    const adapter = new FakeMediaAdapter();
    const first = new NarrationRecorder(adapter);
    first.destroy();
    const second = new NarrationRecorder(adapter);
    await flush();
    expect(adapter.getUserMediaCount).toBe(0);
    expect(adapter.recorders).toHaveLength(0);
    expect(adapter.tracks).toHaveLength(0);
    expect(second.getState().phase).toBe('idle');

    // Only the surviving (second) instance can drive a session.
    second.enable();
    await flush();
    expect(adapter.getUserMediaCount).toBe(1);
    expect(adapter.recorders).toHaveLength(1);
  });

  it('negotiates the MIME type before constructing the recorder', async () => {
    const adapter = new FakeMediaAdapter({ mimeType: 'audio/ogg;codecs=opus' });
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    expect(adapter.negotiatedTypes).toEqual(['audio/ogg;codecs=opus']);
    expect(adapter.lastRecorder!.mimeType).toBe('audio/ogg;codecs=opus');
  });

  it('collapses duplicate enable() clicks while requesting', async () => {
    const adapter = new FakeMediaAdapter();
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    rec.enable();
    rec.enable();
    expect(adapter.getUserMediaCount).toBe(1);
    await flush();
    expect(rec.getState().phase).toBe('armed');
    expect(adapter.recorders).toHaveLength(1);
  });

  it('does not touch media when unsupported', async () => {
    const adapter = new FakeMediaAdapter({ isSupported: false });
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    const s = rec.getState();
    expect(s.phase).toBe('error');
    expect(s.errorCode).toBe('UNSUPPORTED');
    expect(adapter.getUserMediaCount).toBe(0);
    expect(adapter.recorders).toHaveLength(0);
  });

  it.each([
    [fakeErrors.notAllowed, 'PERMISSION_DENIED'],
    [fakeErrors.notFound, 'NO_DEVICE'],
    [fakeErrors.notReadable, 'NO_DEVICE'],
    [fakeErrors.abort, 'NO_DEVICE'],
    [fakeErrors.other, 'NO_DEVICE'],
  ] as const)('maps grant failure %s -> %s', async (err, code) => {
    const adapter = new FakeMediaAdapter({ grant: { reject: err } });
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    const s = rec.getState();
    expect(s.phase).toBe('error');
    expect(s.errorCode).toBe(code);
  });

  it('flags a grant with no audio tracks as NO_DEVICE', async () => {
    const adapter = new FakeMediaAdapter({ grant: 'no-tracks' });
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    expect(rec.getState().errorCode).toBe('NO_DEVICE');
    expect(adapter.recorders).toHaveLength(0);
  });

  it('flags an already-ended track as NO_DEVICE', async () => {
    const adapter = new FakeMediaAdapter({ grant: 'ended-track' });
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    expect(rec.getState().errorCode).toBe('NO_DEVICE');
    // The dead track is still released idempotently.
    for (const t of adapter.tracks) expect(t.readyState).toBe('ended');
  });

  it('reports recorder construction failure as UNSUPPORTED and frees tracks', async () => {
    const adapter = new FakeMediaAdapter({ recorderCtorThrows: true });
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    expect(rec.getState().errorCode).toBe('UNSUPPORTED');
    expect(adapter.tracks[0].stopCount).toBe(1);
    expect(adapter.graphs[0].closed).toBe(true);
  });

  it('recovers after an error via the retry path', async () => {
    const adapter = new FakeMediaAdapter({
      grant: { reject: fakeErrors.notAllowed },
    });
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    expect(rec.getState().phase).toBe('error');
    adapter.grant = 'allow';
    rec.enable();
    await flush();
    expect(rec.getState().phase).toBe('armed');
    expect(adapter.getUserMediaCount).toBe(2);
  });
});

describe('start / stop', () => {
  it('ignores repeated start() and start outside armed', async () => {
    const { adapter, rec } = await armed({});
    rec.start();
    rec.start(); // duplicate while recording
    expect(adapter.lastRecorder!.startCount).toBe(1);
    rec.reset();
    await flush();
    rec.start(); // idle: no-op
    expect(adapter.lastRecorder!.startCount).toBe(1);
  });

  it('maps a throwing start() to START_FAILED', async () => {
    const { rec } = await armed({ recorderStartThrows: true });
    rec.start();
    expect(rec.getState().errorCode).toBe('START_FAILED');
  });

  it('maps recorder errors while armed to START_FAILED', async () => {
    const { adapter, rec } = await armed({ autoFinal: false });
    // Simulate a device-open failure right at start (state stays inactive).
    adapter.lastRecorder!.fireError();
    expect(rec.getState().errorCode).toBe('START_FAILED');
  });

  it('produces a take only after the final non-empty block AND stop', async () => {
    const adapter = new FakeMediaAdapter({ autoFinal: false, finalSize: 64 });
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    rec.start();
    adapter.advance(200);
    const recorder = adapter.lastRecorder!;

    // Mid-recording blocks are collected but do not finalize anything.
    recorder.fireData(32);
    expect(rec.getState().phase).toBe('recording');
    expect(rec.getState().take).toBeNull();

    rec.stop();
    expect(rec.getState().phase).toBe('packaging');

    // Real MediaRecorder drains the final dataavailable first, then stop.
    recorder.fireData(64);
    expect(rec.getState().phase).toBe('packaging');
    recorder.fireStop();
    await flush();
    expect(rec.getState().phase).toBe('review');
    const take = rec.getState().take!;
    expect(take.size).toBe(96);
    expect(take.sessionId).toBe(rec.getState().sessionId);
  });

  it('a stop event without any final block is an empty, recoverable take', async () => {
    const adapter = new FakeMediaAdapter({ autoFinal: false });
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    rec.start();
    rec.stop();
    // Recorder ends without delivering dataavailable at all.
    adapter.lastRecorder!.fireStop();
    await flush();
    expect(rec.getState().errorCode).toBe('EMPTY_DATA');
    expect(adapter.tracks[0].readyState).toBe('ended');
  });

  it('rejects empty final data (zero-size tail)', async () => {
    const adapter = new FakeMediaAdapter({
      autoFinal: false,
      finalSize: 0,
    });
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    rec.start();
    rec.stop();
    adapter.lastRecorder!.fireData(0);
    adapter.lastRecorder!.fireStop();
    await flush();
    expect(rec.getState().errorCode).toBe('EMPTY_DATA');
    expect(rec.getState().take).toBeNull();
  });

  it('reports packaging failures', async () => {
    const a1 = new FakeMediaAdapter({ assemble: 'throw' });
    const r1 = new NarrationRecorder(a1);
    r1.enable();
    await flush();
    r1.start();
    r1.stop();
    await flush();
    expect(r1.getState().errorCode).toBe('PACKAGING_FAILED');

    const a2 = new FakeMediaAdapter({ assemble: 'empty' });
    const r2 = new NarrationRecorder(a2);
    r2.enable();
    await flush();
    r2.start();
    r2.stop();
    await flush();
    expect(r2.getState().errorCode).toBe('EMPTY_DATA');
  });

  it('uses the monotonic clock delta for duration, not frame count', async () => {
    const adapter = new FakeMediaAdapter({ level: 0.25, startTime: 5000 });
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    rec.start();

    // Background tab: zero frame refreshes happen during the recording.
    adapter.advance(3000);
    expect(rec.getState().elapsedMs).toBe(0); // no publish without a frame
    rec.refreshMeter();
    expect(rec.getState().elapsedMs).toBe(3000);
    expect(rec.getState().level).toBeCloseTo(0.25);

    adapter.advance(123);
    rec.stop();
    await flush();
    expect(rec.getState().take!.durationMs).toBe(3123);
  });

  it('reschedules frame refresh but never re-starts the recorder', async () => {
    const adapter = new FakeMediaAdapter({ level: 0.4 });
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    rec.start();
    adapter.flushFrames();
    adapter.flushFrames();
    expect(adapter.lastRecorder!.startCount).toBe(1);
    expect(rec.getState().level).toBeCloseTo(0.4);
    rec.stop();
    await flush();
    // Frame loop cancelled on stop: no lingering handles.
    expect(adapter.pendingFrameCount).toBe(0);
  });
});

describe('track interruption', () => {
  it('ends the session with TRACK_ENDED and releases the mic', async () => {
    const { adapter, rec } = await armed({ autoFinal: false });
    rec.start();
    adapter.tracks[0].fireEnded();
    const s = rec.getState();
    expect(s.phase).toBe('error');
    expect(s.errorCode).toBe('TRACK_ENDED');
    expect(adapter.tracks[0].readyState).toBe('ended');
    expect(adapter.graphs[0].closed).toBe(true);
  });

  it('maps recorder encoding errors during recording to ENCODE_FAILED', async () => {
    const { adapter, rec } = await armed({});
    rec.start();
    adapter.lastRecorder!.fireError();
    expect(rec.getState().errorCode).toBe('ENCODE_FAILED');
  });

  it('an explicit stop after a natural end is a no-op', async () => {
    const { adapter, rec } = await armed({ autoFinal: false });
    rec.start();
    adapter.tracks[0].fireEnded();
    rec.stop(); // already error
    expect(rec.getState().phase).toBe('error');
  });
});

describe('late events vs newer sessions', () => {
  it('discard arms an incremented session; a re-record replaces the take', async () => {
    const { adapter, rec } = await recorded({ finalSize: 100 });
    const take1 = rec.getState().take!;
    expect(take1.sessionId).toBe(1);

    rec.discard();
    expect(rec.getState().phase).toBe('requesting');
    expect(adapter.revokedUrls).toContain(take1.url);
    await flush();
    expect(rec.getState().phase).toBe('armed');
    expect(rec.getState().sessionId).toBe(2);

    rec.start();
    adapter.advance(400);
    rec.stop();
    await flush();
    const take2 = rec.getState().take!;
    expect(take2.sessionId).toBe(2);
    expect(take2.url).not.toBe(take1.url);
  });

  it('late final block + stop from a superseded session cannot overwrite take', async () => {
    const adapter = new FakeMediaAdapter({ autoFinal: false });
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    rec.start();
    const firstRecorder = adapter.lastRecorder as FakeRecorder;

    // Abandon take 1 while still recording, arm session 2.
    rec.reset();
    await flush();
    rec.enable();
    await flush();
    expect(rec.getState().sessionId).toBe(2);

    // Late events from the dead session 1 land after session 2 is armed.
    firstRecorder.fireData(500);
    firstRecorder.fireStop();
    await flush();
    expect(rec.getState().phase).toBe('armed');
    expect(rec.getState().take).toBeNull();
  });

  it('events arriving during packaging of a fresh session are session-bound', async () => {
    // Session 1 fully records; a new session starts; only session 2's final
    // block builds session 2's take.
    const adapter = new FakeMediaAdapter({ autoFinal: false });
    const rec = new NarrationRecorder(adapter);

    rec.enable();
    await flush();
    rec.start();
    const r1 = adapter.lastRecorder!;
    rec.stop();
    r1.fireData(11);
    r1.fireStop();
    await flush();
    expect(rec.getState().take!.size).toBe(11);

    rec.discard();
    await flush();
    rec.start();
    // Extremely late duplicated events from recorder 1 (already detached).
    r1.fireData(999);
    r1.fireStop();
    const r2 = adapter.lastRecorder!;
    expect(r2).not.toBe(r1);
    rec.stop();
    r2.fireData(22);
    r2.fireStop();
    await flush();
    expect(rec.getState().take!.size).toBe(22);
    expect(rec.getState().take!.sessionId).toBe(2);
  });

  it('a grant resolving after reset/destroy releases its stream quietly', async () => {
    const adapter = new FakeMediaAdapter();
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    rec.reset(); // back to idle mid-prompt
    await flush();
    expect(rec.getState().phase).toBe('idle');
    // The late grant's tracks were stopped even though no session adopted it.
    expect(adapter.tracks[adapter.tracks.length - 1].readyState).toBe('ended');

    const adapter2 = new FakeMediaAdapter();
    const rec2 = new NarrationRecorder(adapter2);
    rec2.enable();
    rec2.destroy();
    await flush();
    expect(adapter2.tracks[adapter2.tracks.length - 1].readyState).toBe(
      'ended',
    );
  });
});

describe('cleanup', () => {
  it('stop while recording: tracks stopped, graph closed, listeners detached', async () => {
    const { adapter } = await recorded({});
    const track = adapter.tracks[0];
    const graph = adapter.graphs[0];
    const recorder = adapter.lastRecorder!;
    expect(track.readyState).toBe('ended');
    expect(graph.closed).toBe(true);
    expect(recorder.state).toBe('inactive');
    expect(recorder.listenerCount('dataavailable')).toBe(0);
    expect(recorder.listenerCount('stop')).toBe(0);
    expect(track.endedListenerCount).toBe(0);
    expect(adapter.pendingFrameCount).toBe(0);
  });

  it('destroy while recording is idempotent and tears everything down', async () => {
    const adapter = new FakeMediaAdapter({ autoFinal: false });
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    rec.start();
    const recorder = adapter.lastRecorder!;

    rec.destroy();
    expect(adapter.tracks[0].readyState).toBe('ended');
    expect(adapter.graphs[0].closed).toBe(true);
    expect(recorder.stopCount).toBe(1);

    // Second destroy / late events change nothing.
    rec.destroy();
    recorder.fireData(77);
    recorder.fireStop();
    recorder.fireError();
    adapter.tracks[0].fireEnded();
    expect(adapter.tracks[0].stopCount).toBe(1);
  });

  it('destroy after review revokes the take URL exactly once', async () => {
    const adapter = new FakeMediaAdapter({});
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    rec.start();
    rec.stop();
    await flush();
    const url = rec.getState().take!.url;
    rec.destroy();
    expect(adapter.revokedUrls.filter((u) => u === url)).toHaveLength(1);
    // Calls after destroy are harmless and cannot revoke again.
    rec.reset();
    rec.discard();
    expect(adapter.revokedUrls.filter((u) => u === url)).toHaveLength(1);
  });

  it('reset stops an in-flight recording and ignores its late finalization', async () => {
    const adapter = new FakeMediaAdapter({ autoFinal: false });
    const rec = new NarrationRecorder(adapter);
    rec.enable();
    await flush();
    rec.start();
    rec.reset();
    expect(rec.getState().phase).toBe('idle');
    const recorder = adapter.lastRecorder!;
    expect(recorder.stopCount).toBe(1);
    recorder.fireData(40);
    recorder.fireStop();
    await flush();
    expect(rec.getState().phase).toBe('idle');
    expect(rec.getState().take).toBeNull();
    expect(adapter.createdUrls).toHaveLength(0);
  });
});
