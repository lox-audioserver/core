import assert from 'node:assert/strict';
import { test } from './testHarness';
import { AudioMeter, type EbuLoudness } from '../src/application/audio/audioMeter';

const RATE = 48_000;
const CHUNK_FRAMES = RATE / 10; // 100 ms, which is also the loudness meter's own sub-block

/** A stereo s24le buffer from two per-sample generators. */
function pcm(frames: number, at: number, left: (n: number) => number, right: (n: number) => number): Buffer {
  const buffer = Buffer.alloc(frames * 6);
  for (let i = 0; i < frames; i += 1) {
    const n = at + i;
    const quantise = (value: number): number =>
      Math.max(-8_388_608, Math.min(8_388_607, Math.round(value * 8_388_608)));
    buffer.writeIntLE(quantise(left(n)), i * 6, 3);
    buffer.writeIntLE(quantise(right(n)), i * 6 + 3, 3);
  }
  return buffer;
}

/** Run a signal through a meter for `seconds` and return the last reading of each kind. */
function meter(
  options: {
    left: (n: number) => number;
    right: (n: number) => number;
    seconds: number;
  },
  wanted: Partial<{ ebu: boolean; truePeak: boolean; correlation: boolean; scope: boolean; gonio: boolean }>,
): {
  ebu: EbuLoudness | null;
  truePeak: { left: number; right: number; clips: number } | null;
  correlation: number | null;
  dcOffset: number | null;
  scope: Int8Array | null;
  gonio: Int8Array | null;
} {
  let ebu: EbuLoudness | null = null;
  let truePeak: { left: number; right: number; clips: number } | null = null;
  let correlation: number | null = null;
  let dcOffset: number | null = null;
  let scope: Int8Array | null = null;
  let gonio: Int8Array | null = null;

  const dsp = new AudioMeter({
    sampleRate: RATE,
    channels: 2,
    bitDepth: 24,
    rateMax: 10,
    emitLoudness: false,
    emitFpeak: false,
    emitPeak: false,
    emitPitch: false,
    emitEbu: wanted.ebu === true,
    emitTruePeak: wanted.truePeak === true,
    emitCorrelation: wanted.correlation === true,
    emitScope: wanted.scope === true,
    emitGonio: wanted.gonio === true,
    onEbu: (value) => {
      ebu = value;
    },
    onTruePeak: (left, right, clips) => {
      truePeak = { left, right, clips };
    },
    onCorrelation: (value, dc) => {
      correlation = value;
      dcOffset = dc;
    },
    onScope: (points) => {
      scope = points;
    },
    onGonio: (points) => {
      gonio = points;
    },
  });

  const chunks = Math.round((options.seconds * RATE) / CHUNK_FRAMES);
  for (let c = 0; c < chunks; c += 1) {
    const at = c * CHUNK_FRAMES;
    dsp.push(pcm(CHUNK_FRAMES, at, options.left, options.right), (at / RATE) * 1_000_000);
  }
  return { ebu, truePeak, correlation, dcOffset, scope, gonio };
}

const sine = (dbfs: number, hz: number, phase = 0) => {
  const amplitude = 10 ** (dbfs / 20);
  return (n: number): number => amplitude * Math.sin((2 * Math.PI * hz * n) / RATE + phase);
};

/*
 * EBU Tech 3341, the first compliance case: a 1 kHz sine at −23 dBFS in both channels reads
 * −23.0 LUFS. It is the one test that proves the whole chain at once — the K-weighting design at
 * this sample rate, the channel summing, the block grid, the gating and the −0.691 offset. Any of
 * them wrong and this number is not −23.
 */
test('R128 reads a −23 dBFS stereo 1 kHz sine as −23 LUFS', () => {
  const tone = sine(-23, 1000);
  const { ebu } = meter({ left: tone, right: tone, seconds: 6 }, { ebu: true });
  assert.ok(ebu, 'a reading was emitted');
  const reading = ebu as EbuLoudness;
  assert.ok(reading.momentary !== null && Math.abs(reading.momentary + 23) < 0.15, `momentary ${reading.momentary}`);
  assert.ok(reading.shortTerm !== null && Math.abs(reading.shortTerm + 23) < 0.15, `short-term ${reading.shortTerm}`);
  assert.ok(reading.integrated !== null && Math.abs(reading.integrated + 23) < 0.15, `integrated ${reading.integrated}`);
  // One steady tone has no loud and quiet passages: the range is zero, not absent.
  assert.ok(reading.range !== null && reading.range < 0.2, `range ${reading.range}`);
});

/* The second case, ten dB down: the meter has to be linear, not merely calibrated at one point. */
test('R128 follows level', () => {
  const tone = sine(-33, 1000);
  const { ebu } = meter({ left: tone, right: tone, seconds: 6 }, { ebu: true });
  const reading = ebu as EbuLoudness;
  assert.ok(reading.integrated !== null && Math.abs(reading.integrated + 33) < 0.15, `integrated ${reading.integrated}`);
});

/* And silence has nothing to report rather than a very quiet number. */
test('R128 gates silence out entirely', () => {
  const { ebu } = meter({ left: () => 0, right: () => 0, seconds: 4 }, { ebu: true });
  const reading = ebu as EbuLoudness;
  assert.equal(reading.integrated, null);
  assert.equal(reading.momentary, null);
});

/*
 * True peak, on the signal that exists to catch a meter that only reads samples: a sine at a quarter
 * of the sample rate offset by 45° never lands on its own crest. Every sample sits at 0.707 of the
 * amplitude — a sample meter reads −9.0 dBFS — while the waveform between them reaches −6.0 dBTP.
 */
test('true peak finds the peak between the samples', () => {
  const tone = sine(-6.02, RATE / 4, Math.PI / 4);
  const { truePeak } = meter({ left: tone, right: tone, seconds: 1 }, { truePeak: true });
  assert.ok(truePeak, 'a reading was emitted');
  const reading = truePeak as { left: number; right: number; clips: number };
  assert.ok(Math.abs(reading.left + 6.02) < 0.5, `true peak ${reading.left}`);
  assert.ok(Math.abs(reading.right + 6.02) < 0.5, `true peak ${reading.right}`);
  assert.equal(reading.clips, 0);
});

test('true peak counts samples that ran out of headroom', () => {
  const square = (n: number): number => (n % 2 === 0 ? 1 : -1);
  const { truePeak } = meter({ left: square, right: square, seconds: 0.5 }, { truePeak: true });
  const reading = truePeak as { left: number; right: number; clips: number };
  assert.ok(reading.clips > 1000, `clips ${reading.clips}`);
});

/*
 * Correlation, on the three signals whose answers are not a matter of opinion: the same audio in
 * both channels is +1, one side inverted is −1, and two channels in quadrature are uncorrelated.
 */
test('correlation reads phase, not level', () => {
  const tone = sine(-12, 700);
  const same = meter({ left: tone, right: tone, seconds: 0.5 }, { correlation: true });
  assert.ok(same.correlation !== null && Math.abs(same.correlation - 1) < 0.01, `${same.correlation}`);

  const flipped = meter({ left: tone, right: (n) => -tone(n), seconds: 0.5 }, { correlation: true });
  assert.ok(flipped.correlation !== null && Math.abs(flipped.correlation + 1) < 0.01, `${flipped.correlation}`);

  const quadrature = meter(
    { left: tone, right: sine(-12, 700, Math.PI / 2), seconds: 0.5 },
    { correlation: true },
  );
  assert.ok(quadrature.correlation !== null && Math.abs(quadrature.correlation) < 0.05, `${quadrature.correlation}`);

  const quiet = meter({ left: () => 0, right: () => 0, seconds: 0.5 }, { correlation: true });
  assert.equal(quiet.correlation, 1);
});

/*
 * The two pictures. The scope keeps the envelope — a decimation that aliased would flatten a tone
 * whose period is shorter than a bucket — and the goniometer's dots stay *pairs*: identical channels
 * must draw the 45° line exactly, which is only true if both bytes of a dot come from one instant.
 */
test('scope keeps the envelope and the goniometer keeps its pairs', () => {
  const tone = sine(-6, 3000);
  const { scope, gonio } = meter({ left: tone, right: tone, seconds: 0.5 }, { scope: true, gonio: true });
  assert.ok(scope, 'a trace was emitted');
  const trace = scope as Int8Array;
  assert.equal(trace.length, 160);
  const loudest = Math.max(...[...trace].map((value) => Math.abs(value)));
  // −6 dBFS is half of full scale, and every bucket of a 3 kHz tone contains a crest.
  assert.ok(loudest > 55 && loudest <= 70, `trace peak ${loudest}`);
  const quietest = Math.min(...[...trace].map((value) => Math.abs(value)));
  assert.ok(quietest > 45, `a decimation that aliased would show a near-zero bucket: ${quietest}`);

  const dots = gonio as Int8Array;
  assert.equal(dots.length, 256);
  for (let i = 0; i < dots.length; i += 2) {
    assert.equal(dots[i], dots[i + 1], 'identical channels put every dot on the 45° line');
  }
});

/* A new track starts the running measurements over; the window rings are left alone. */
test('reset clears the integrator and the clip count', () => {
  const dsp = new AudioMeter({
    sampleRate: RATE,
    channels: 2,
    bitDepth: 24,
    rateMax: 10,
    emitLoudness: false,
    emitFpeak: false,
    emitPeak: false,
    emitPitch: false,
    emitEbu: true,
    emitTruePeak: true,
    onEbu: (value) => {
      readings.push(value);
    },
    onTruePeak: (_left, _right, clips) => {
      clipCounts.push(clips);
    },
  });
  const readings: EbuLoudness[] = [];
  const clipCounts: number[] = [];
  const square = (n: number): number => (n % 2 === 0 ? 1 : -1);

  for (let c = 0; c < 60; c += 1) {
    const at = c * CHUNK_FRAMES;
    dsp.push(pcm(CHUNK_FRAMES, at, square, square), (at / RATE) * 1_000_000);
  }
  assert.ok((readings.at(-1)?.integrated ?? null) !== null, 'the meter had a figure');
  assert.ok((clipCounts.at(-1) ?? 0) > 0, 'and a clip count');

  dsp.reset();
  const at = 60 * CHUNK_FRAMES;
  dsp.push(pcm(CHUNK_FRAMES, at, () => 0, () => 0), (at / RATE) * 1_000_000);
  assert.equal(readings.at(-1)?.integrated, null);
  assert.equal(clipCounts.at(-1), 0);
});

/*
 * DC offset, on the two signals whose answer is not a matter of opinion: a tone centred on zero has
 * none, and a tone with a constant added has exactly that constant. The first version of this
 * measured one 43 ms window, which does not contain a whole cycle of anything below 23 Hz — it read
 * half a percent of offset on music that had none. This is the test that would have caught it.
 */
test('DC offset averages over seconds, not over one window', () => {
  const tone = sine(-12, 60);
  const centred = meter({ left: tone, right: tone, seconds: 6 }, { correlation: true });
  assert.ok(Math.abs(centred.dcOffset ?? 1) < 0.001, `centred read ${centred.dcOffset}`);

  const offset = (n: number): number => tone(n) + 0.05;
  const shifted = meter({ left: offset, right: offset, seconds: 12 }, { correlation: true });
  assert.ok(
    Math.abs((shifted.dcOffset ?? 0) - 0.05) < 0.01,
    `a 5% offset read ${shifted.dcOffset}`,
  );
});
