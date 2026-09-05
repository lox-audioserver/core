import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  PcmFrameAssembler,
  TimedFrameScheduler,
  type TimedFrame,
} from '../src/shared/audio/timedFrameScheduler';

// Pacing and frame assembly, which is where drift and off-by-one live. Both classes are
// deterministic — the scheduler takes its clock as an option — so this can be pinned exactly
// rather than approximately, and a wrong answer here is audible rather than visible.

// ── PcmFrameAssembler ──────────────────────────────────────────────────────────

function assembler(over: Partial<{ sampleRate: number; channels: number; bitDepth: number; frameDurationMs: number }> = {}) {
  const frames: Array<{ bytes: number; samples: number; durationUs: number }> = [];
  const a = new PcmFrameAssembler({
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
    ...over,
    onFrame: (data, samples, durationUs) =>
      frames.push({ bytes: data.length, samples, durationUs }),
  });
  return { a, frames };
}

// 44100 × 25 ms is 1102.5 samples, and half a sample cannot be sent. The frame is 1102
// samples, so its duration is 24988 µs and not the 25000 the caller asked for. That is the
// right answer — the duration has to describe the audio actually in the buffer — but it is
// the kind of number a reader assumes, so it is written down.
test('a frame lasts as long as the samples in it, not as long as it was asked to', () => {
  const { a, frames } = assembler();
  a.push(Buffer.alloc(4408));
  assert.deepEqual(frames, [{ bytes: 4408, samples: 1102, durationUs: 24988 }]);
});

test('a chunk that splits a sample holds the tail back instead of shifting the channels', () => {
  const { a, frames } = assembler();
  // 4408 bytes make a frame; feed 4406 so two bytes of the last stereo sample are missing.
  a.push(Buffer.alloc(4406));
  assert.deepEqual(frames, [], 'nothing yet: a frame is only whole samples');
  // The two bytes that complete it arrive next. Dropping them, or emitting them as if they
  // were a whole sample, swaps left and right for the rest of the stream.
  a.push(Buffer.alloc(2));
  assert.deepEqual(frames, [{ bytes: 4408, samples: 1102, durationUs: 24988 }]);
});

test('a chunk larger than one frame yields every whole frame and keeps the rest', () => {
  const { a, frames } = assembler();
  a.push(Buffer.alloc(4408 * 2 + 100));
  assert.equal(frames.length, 2);
  // The 100 leftover bytes are not lost: they complete the next frame.
  a.push(Buffer.alloc(4408 - 100));
  assert.equal(frames.length, 3);
  assert.deepEqual(new Set(frames.map((f) => f.bytes)), new Set([4408]));
});

test('reset drops a half-built frame rather than carrying it into the next track', () => {
  const { a, frames } = assembler();
  a.push(Buffer.alloc(4000));
  a.reset();
  a.push(Buffer.alloc(408));
  assert.deepEqual(frames, [], 'the 4000 bytes are gone, so 408 is not suddenly a frame');
});

test('an empty chunk changes nothing', () => {
  const { a, frames } = assembler();
  a.push(Buffer.alloc(0));
  assert.deepEqual(frames, []);
});

// A frame duration small enough to round to zero samples would make a frame of no bytes and
// no duration, which the scheduler drops — so the stream would stall rather than play fast.
test('a frame can never be zero samples long', () => {
  const { a, frames } = assembler({ sampleRate: 8000, frameDurationMs: 0 });
  a.push(Buffer.alloc(64));
  assert.equal(frames[0]!.samples, 1);
});

// ── TimedFrameScheduler ────────────────────────────────────────────────────────

const FRAME_US = 25_000;

function scheduler(
  over: Partial<{ targetLeadUs: number; anchorLeadUs: number; shouldContinue: () => boolean }> = {},
) {
  let nowUs = 0;
  const sent: TimedFrame[] = [];
  const events: Array<[string, number]> = [];
  const s = new TimedFrameScheduler({
    nowUs: () => nowUs,
    targetLeadUs: 5_000_000,
    anchorLeadUs: 1_000_000,
    ...over,
    onFrame: (frame) => {
      sent.push(frame);
    },
    onAnchor: (us) => events.push(['anchor', us]),
    onAdjust: (us) => events.push(['adjust', us]),
    onTimelineShift: (us) => events.push(['shift', us]),
  });
  return {
    s,
    sent,
    events,
    advanceTo: (us: number) => {
      nowUs = us;
    },
  };
}

/** The queue drains on its own promise chain; give it room to finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('the first frame anchors the timeline a lead ahead of now', async () => {
  const h = scheduler();
  h.s.scheduleFrame(Buffer.alloc(8), FRAME_US);
  await settle();

  assert.deepEqual(h.events, [['anchor', 1_000_000]]);
  assert.equal(h.sent[0]!.timestampUs, 1_000_000, 'played one anchor-lead from now, not now');
  assert.deepEqual(h.s.getTimelineState(), {
    playStartUs: 1_000_000,
    modeledTimelineUs: FRAME_US,
  });
});

test('each frame follows the one before it by its own duration', async () => {
  const h = scheduler();
  h.s.scheduleFrame(Buffer.alloc(8), FRAME_US);
  h.s.scheduleFrame(Buffer.alloc(8), FRAME_US);
  h.s.scheduleFrame(Buffer.alloc(8), 10_000);
  await settle();

  assert.deepEqual(
    h.sent.map((f) => f.timestampUs),
    [1_000_000, 1_025_000, 1_050_000],
  );
  // The modelled timeline is the sum of what was scheduled, not a frame count.
  assert.equal(h.s.getTimelineState().modeledTimelineUs, FRAME_US * 2 + 10_000);
});

// The drift correction, and the reason this file is worth a test. A frame whose slot has
// already passed cannot be un-late: sending it as-is means the client drops it. The whole
// timeline moves instead, so the frame lands in the future and every later frame stays
// continuous with it.
test('a frame whose slot has passed moves the whole timeline, not just itself', async () => {
  const h = scheduler();
  h.s.scheduleFrame(Buffer.alloc(8), FRAME_US);
  await settle();

  // Two seconds of wall clock with nothing scheduled: the next frame's slot is long gone.
  h.advanceTo(2_000_000);
  h.s.scheduleFrame(Buffer.alloc(8), FRAME_US);
  await settle();

  assert.deepEqual(h.events.slice(1), [
    ['adjust', 5_000_000],
    ['shift', 5_000_000],
  ]);
  assert.equal(h.sent[1]!.timestampUs, 6_025_000, 'the late frame is placed ahead, not dropped');
  assert.equal(
    h.s.getTimelineState().playStartUs,
    6_000_000,
    'the anchor moved with it, so position reporting stays true',
  );

  // Continuity is the point: the frame after the shift follows on from the shifted slot.
  h.s.scheduleFrame(Buffer.alloc(8), FRAME_US);
  await settle();
  assert.equal(h.sent[2]!.timestampUs, 6_050_000);
});

test('stop clears what was queued and sends no more', async () => {
  const h = scheduler();
  h.s.scheduleFrame(Buffer.alloc(8), FRAME_US);
  await settle();
  h.s.stop();
  h.s.scheduleFrame(Buffer.alloc(8), FRAME_US);
  await settle();

  assert.equal(h.sent.length, 1);
});

test('a source that says it is done stops the queue mid-drain', async () => {
  let live = true;
  const h = scheduler({ shouldContinue: () => live });
  h.s.scheduleFrame(Buffer.alloc(8), FRAME_US);
  await settle();
  live = false;
  h.s.scheduleFrame(Buffer.alloc(8), FRAME_US);
  h.s.scheduleFrame(Buffer.alloc(8), FRAME_US);
  await settle();

  assert.equal(h.sent.length, 1, 'nothing is sent to a session that has ended');
});

test('an empty or zero-length frame is not scheduled', async () => {
  const h = scheduler();
  h.s.scheduleFrame(Buffer.alloc(0), FRAME_US);
  h.s.scheduleFrame(Buffer.alloc(8), 0);
  h.s.scheduleFrame(Buffer.alloc(8), -1);
  await settle();

  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.events, [], 'and the timeline is not anchored by a frame that never went');
});

test('capacity is waited for per frame, with the bytes that frame needs', async () => {
  let nowUs = 0;
  const asked: number[] = [];
  const waits: number[] = [];
  const s = new TimedFrameScheduler({
    nowUs: () => nowUs,
    targetLeadUs: 5_000_000,
    anchorLeadUs: 1_000_000,
    onFrame: () => {},
    waitForCapacity: async (bytes) => {
      asked.push(bytes);
      nowUs += 3_000; // the wait costs time, which the caller is told about
    },
    onCapacityWait: (us) => waits.push(us),
  });
  s.scheduleFrame(Buffer.alloc(4408), FRAME_US);
  s.scheduleFrame(Buffer.alloc(1024), FRAME_US);
  await settle();

  assert.deepEqual(asked, [4408, 1024]);
  assert.deepEqual(waits, [3_000, 3_000]);
});
