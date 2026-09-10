/**
 * The server's audio meter: every reading this house can take of a stream in flight.
 *
 * It began as the sendspin output's visualizer@v1 DSP and lived in that adapter, which stopped being
 * true some time ago and stopped being harmless when the metering grew. `AudioAnalysisService`
 * constructs one of these for **every** zone whatever its output — the outputs that stream PCM push
 * their frames in, and `analysisFeed` decodes a copy for the ones that only ever have the audio
 * encoded — so a Sonos and a browser tab are measured by exactly this code. A name and a folder that
 * say otherwise are a map that sends the next person to the wrong room.
 *
 * What it produces, and in which units:
 *
 *  - **loudness, spectrum, f_peak, stereo** — u16 *positions in dB* over the `ANALYSIS_DB_FLOOR`…0
 *    window (the visualizer@v1 encoding, written down in `@/domain/audio/analysisScale`). A small
 *    client draws bars from these without doing arithmetic.
 *  - **pitch, peak** — a MIDI note in 8.8 fixed point, and an onset strength.
 *  - **loudness (EBU R128), true peak, correlation, DC offset** — the units a person reads: LUFS,
 *    LU, dBTP, a coefficient, a fraction of full scale. These are numbers to *print*, and re-encoding
 *    them into a 16-bit window would throw away the sign and the precision that make them worth
 *    printing.
 *  - **scope, gonio** — bytes, because they are pictures of one window rather than readings.
 *
 * Everything is opt-in per subscription: the K-weighting runs two biquads over every sample of every
 * channel and the true-peak reconstruction oversamples the loudest neighbourhoods, so a consumer that
 * only wants a spectrum does not pay for a loudness meter it never draws.
 */

import { ANALYSIS_DB_FLOOR, ANALYSIS_FULL_SCALE } from '@/domain/audio/analysisScale';

export type SpectrumScale = 'lin' | 'log' | 'mel';

export interface SpectrumConfig {
  n_disp_bins: number;
  scale: SpectrumScale;
  f_min: number;
  f_max: number;
}

export interface AudioMeterOptions {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  rateMax: number;
  emitLoudness: boolean;
  emitFpeak: boolean;
  emitPeak: boolean;
  emitPitch: boolean;
  /** Per-channel levels (front left/right), for a stereo meter. Mono reports both sides equal. */
  emitStereo?: boolean;
  /** Phase correlation between the front pair, −1…+1. Mono is +1 by definition. */
  emitCorrelation?: boolean;
  /** Inter-sample peak per side, in dBTP, plus a running count of full-scale samples. */
  emitTruePeak?: boolean;
  /** EBU R128 loudness: momentary, short-term, integrated and range. */
  emitEbu?: boolean;
  /** A decimated waveform of the window — an oscilloscope's trace. */
  emitScope?: boolean;
  /** Front-pair sample pairs for a goniometer's Lissajous figure. */
  emitGonio?: boolean;
  spectrum?: SpectrumConfig;
  onLoudness?: (value: number, timestampUs: number) => void;
  onSpectrum?: (bins: Uint16Array, timestampUs: number) => void;
  onFpeak?: (freqHz: number, amplitude: number, timestampUs: number) => void;
  onPeak?: (strength: number, timestampUs: number) => void;
  onPitch?: (midiQ88: number, confidence: number, timestampUs: number) => void;
  onStereo?: (left: number, right: number, timestampUs: number) => void;
  /** Phase correlation, plus the window's DC offset as a fraction of full scale. */
  onCorrelation?: (value: number, dcOffset: number, timestampUs: number) => void;
  onTruePeak?: (leftDbtp: number, rightDbtp: number, clips: number, timestampUs: number) => void;
  onEbu?: (loudness: EbuLoudness, timestampUs: number) => void;
  onScope?: (points: Int8Array, timestampUs: number) => void;
  onGonio?: (points: Int8Array, timestampUs: number) => void;
}

/**
 * EBU R128 loudness, in the units the standard uses.
 *
 * Every field is null until enough audio has passed to state it honestly: momentary needs 400 ms,
 * short-term 3 s, and the integrated figure needs at least one block loud enough to survive the
 * absolute gate. A `0` in any of these would read as "very loud silence", which is why none of them
 * defaults to a number.
 */
export interface EbuLoudness {
  /** LUFS over the last 400 ms. */
  momentary: number | null;
  /** LUFS over the last 3 s. */
  shortTerm: number | null;
  /** Gated LUFS over everything since the meter was reset — the figure a master is judged on. */
  integrated: number | null;
  /** Loudness range in LU: the spread between the quiet and loud passages. */
  range: number | null;
}

/**
 * The analysis window, as a duration — ~43 ms, which is the reference server's 2048 samples at
 * 48 kHz and the point where a spectrum still feels immediate without flickering.
 *
 * Held constant in *time* rather than in samples, because a fixed sample count means the
 * frequency resolution degrades as the rate rises: 2048 points resolve 21 Hz at 44.1 kHz but
 * only 94 Hz at 192 kHz, which puts the entire bass register inside a single FFT bin. That is
 * exactly backwards for a server whose whole point is following the source up to 192/24. The
 * window is therefore the power of two nearest this duration, so resolution stays ~21-23 Hz and
 * the display behaves identically at every rate — at the cost of an FFT that is 4x the work at
 * 192 kHz, measured at well under 2% of one core (scripts/spectrum-probe.ts).
 */
const WINDOW_MS = 43;
const MIN_WINDOW = 1024;
const MAX_WINDOW = 16384;

/** The power-of-two window closest to WINDOW_MS at this rate; radix-2 needs the power of two. */
export function windowSizeFor(sampleRate: number): number {
  const target = (Math.max(8000, sampleRate) * WINDOW_MS) / 1000;
  const size = 2 ** Math.round(Math.log2(target));
  return Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, size));
}
const DB_FLOOR = ANALYSIS_DB_FLOOR;
const U16_MAX = ANALYSIS_FULL_SCALE;
/**
 * Per-bin fall time, so bars settle between attacks instead of flickering.
 *
 * Expressed as a half-life in wall-clock time rather than a factor per emitted frame:
 * the emit rate is the client's choice (`rate_max`), and a per-frame factor made the
 * bars hang three times as long at 10 fps as at 30 fps for the same music.
 */
const SPECTRUM_HALFLIFE_MS = 45;
// Pitch search range (Hz) → autocorrelation lag bounds. Covers bass to soprano.
const PITCH_F_MIN = 80;
const PITCH_F_MAX = 1000;
// Below this windowed RMS the signal is treated as unvoiced (no pitch emitted).
const PITCH_RMS_GATE = 0.005;
// Minimum normalized autocorrelation peak to accept a pitch.
const PITCH_MIN_CONFIDENCE = 0.5;
// Onset detector: fire when broadband energy exceeds its running mean by this
// factor, no more often than the gap below.
const PEAK_THRESHOLD = 1.6;
const PEAK_MIN_GAP_US = 80_000;
const PEAK_EMA = 0.9;

/**
 * How many points a scope trace and a goniometer figure carry.
 *
 * Both are pictures of one analysis window (~43 ms), so the count is a drawing decision rather than
 * a measurement one: enough dots that the shape is a shape, few enough that the stream stays small.
 * 160 points at 30 frames a second is 4.8 kB/s per trace as bytes — which is why they go on the wire
 * as bytes and not as JSON numbers.
 */
const SCOPE_POINTS = 160;
const GONIO_POINTS = 128;

/**
 * The K-weighting filter, from ITU-R BS.1770-4.
 *
 * Two biquads: a high shelf that models the head's response and an RLB high-pass that discards the
 * rumble the ear does not weigh. The standard tabulates coefficients at 48 kHz only, and this server
 * follows the source up to 192 kHz — so they are *designed* here from the prototype's own
 * parameters (the same analytic form libebur128 uses), which gives the identical filter at 48 kHz
 * and the right one everywhere else. Hardcoding the 48 kHz table and using it at 44.1 or 96 would
 * shift both corners and quietly bias every reading.
 */
const SHELF_F0 = 1681.974450955533;
const SHELF_GAIN_DB = 3.999843853973347;
const SHELF_Q = 0.7071752369554196;
const HP_F0 = 38.13547087602444;
const HP_Q = 0.5003270373238773;

/** The offset in the LUFS definition: `-0.691 + 10·log10(z)`. */
const LUFS_OFFSET = -0.691;

/**
 * The gating, in the standard's own numbers.
 *
 * An absolute floor at −70 LUFS throws away silence, and a relative gate 10 LU under the ungated
 * mean throws away the quiet passages — which is what makes an integrated reading describe the
 * *programme* rather than the gaps in it. The loudness range uses the same idea with a wider skirt
 * and reads the spread between its 10th and 95th percentiles.
 */
const GATE_ABSOLUTE_LUFS = -70;
const GATE_RELATIVE_LU = -10;
const RANGE_RELATIVE_LU = -20;
const RANGE_LOW_PERCENTILE = 0.1;
const RANGE_HIGH_PERCENTILE = 0.95;

/** The meter's block grid: 400 ms and 3 s windows, both stepped every 100 ms. */
const EBU_SUBBLOCK_MS = 100;
const EBU_MOMENTARY_SUBBLOCKS = 4;
const EBU_SHORT_SUBBLOCKS = 30;
/** How often a short-term reading is filed for the range calculation. */
const EBU_RANGE_STEP_SUBBLOCKS = 10;
/**
 * How many filed blocks the gated readings keep: three hours of programme.
 *
 * A cap rather than an unbounded array, because this runs in a long-lived server process and an
 * integrated reading over three hours is already well past the point where one more block moves it.
 */
const EBU_MAX_BLOCKS = 108_000;

/** How slowly the two gated readings are recomputed — they move over minutes, not frames. */
const EBU_GATED_INTERVAL_US = 400_000;

/**
 * True-peak reconstruction: 4× oversampling, 12 taps a phase.
 *
 * BS.1770-4 asks for at least 4× and publishes one 48-tap table; the kernel here is built instead
 * from a Blackman-windowed sinc, which is the same construction at the same length and works at
 * every sample rate. It is an *estimator* either way — the true analogue peak is only approached,
 * never computed — and 4× is where the standard says the error stops mattering.
 *
 * Only the neighbourhoods of the window's loudest samples are reconstructed. Interpolating all of
 * them would be 96 multiplies a sample a channel — 47 M/s at 192 kHz, for a reading whose answer
 * lives within a sample or two of a local maximum. Everything within 6 dB of the sample peak is
 * examined, capped so a square wave cannot turn one frame into a thousand candidates.
 */
const TP_OVERSAMPLE = 4;
const TP_TAPS = 12;
const TP_CENTER = 5;
const TP_CANDIDATE_DB = 6;
const TP_MAX_CANDIDATES = 96;

/**
 * How long the DC estimate averages over.
 *
 * A window's mean is *not* a DC offset. 43 ms does not contain a whole cycle of anything below 23 Hz,
 * so the mean of one window moves with the bass — the first version of this read −0.5% on a track
 * with no offset at all, which is a meter inventing a fault. Two seconds is long enough that every
 * audible frequency averages to zero and short enough to notice an offset appearing mid-track.
 */
const DC_AVERAGE_SEC = 2;

/** Just under full scale: what counts as a sample that has run out of headroom. */
const CLIP_THRESHOLD = 0.999_969;

/** One direct-form-1 biquad, with its own history. */
type Biquad = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
};

function shelfBiquad(sampleRate: number): Biquad {
  const k = Math.tan((Math.PI * SHELF_F0) / sampleRate);
  const vh = 10 ** (SHELF_GAIN_DB / 20);
  const vb = vh ** 0.499_666_774_154_6;
  const a0 = 1 + k / SHELF_Q + k * k;
  return {
    b0: (vh + (vb * k) / SHELF_Q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / SHELF_Q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / SHELF_Q + k * k) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}

function highPassBiquad(sampleRate: number): Biquad {
  const k = Math.tan((Math.PI * HP_F0) / sampleRate);
  const a0 = 1 + k / HP_Q + k * k;
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / HP_Q + k * k) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}

function biquad(state: Biquad, x: number): number {
  const y =
    state.b0 * x + state.b1 * state.x1 + state.b2 * state.x2 - state.a1 * state.y1 - state.a2 * state.y2;
  state.x2 = state.x1;
  state.x1 = x;
  state.y2 = state.y1;
  state.y1 = y;
  return y;
}

function resetBiquad(state: Biquad): void {
  state.x1 = 0;
  state.x2 = 0;
  state.y1 = 0;
  state.y2 = 0;
}

/**
 * BS.1770 channel weights.
 *
 * The front three count once and the surrounds count 1.41× — the standard's way of saying that
 * sound arriving from behind is heard as louder than the same energy in front. Everything this
 * server streams is mono or stereo, so in practice this is a row of ones; it is written out because
 * a weight that is silently 1 for a 5.1 stream is a wrong reading rather than a missing feature.
 */
function channelWeight(channel: number): number {
  return channel === 3 || channel === 4 ? 1.41 : 1;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** The polyphase kernel, phase-major: `[phase * TP_TAPS + tap]`, each phase summing to 1. */
function truePeakKernel(): Float64Array {
  const kernel = new Float64Array(TP_OVERSAMPLE * TP_TAPS);
  for (let phase = 0; phase < TP_OVERSAMPLE; phase += 1) {
    let sum = 0;
    for (let tap = 0; tap < TP_TAPS; tap += 1) {
      const distance = phase / TP_OVERSAMPLE - (tap - TP_CENTER);
      // Blackman over the kernel's own support, so the far taps leave quietly.
      const position = (distance + TP_CENTER + 1) / TP_TAPS;
      const window =
        0.42 - 0.5 * Math.cos(2 * Math.PI * position) + 0.08 * Math.cos(4 * Math.PI * position);
      const value = sinc(distance) * window;
      kernel[phase * TP_TAPS + tap] = value;
      sum += value;
    }
    if (sum !== 0) {
      for (let tap = 0; tap < TP_TAPS; tap += 1) {
        kernel[phase * TP_TAPS + tap] = kernel[phase * TP_TAPS + tap]! / sum;
      }
    }
  }
  return kernel;
}

/** Mean of an array of block powers — the `z` the LUFS formula takes. */
function meanOf(values: number[], from = 0): number {
  if (values.length <= from) return 0;
  let sum = 0;
  for (let i = from; i < values.length; i += 1) sum += values[i]!;
  return sum / (values.length - from);
}

function lufsOf(z: number): number | null {
  if (!(z > 0)) return null;
  return LUFS_OFFSET + 10 * Math.log10(z);
}

/**
 * The gated mean, both gates, as the standard sequences them.
 *
 * Returns the surviving blocks as well as the figure, because the loudness range needs the same
 * gating with a different skirt and computing it twice from two copies of this logic is how the two
 * readings end up disagreeing about which passages counted.
 */
function gate(blocks: number[], relativeLu: number): { z: number; kept: number[] } {
  const absolute = 10 ** ((GATE_ABSOLUTE_LUFS - LUFS_OFFSET) / 10);
  const loud = blocks.filter((z) => z > absolute);
  if (loud.length === 0) {
    return { z: 0, kept: [] };
  }
  const relative = meanOf(loud) * 10 ** (relativeLu / 10);
  const kept = loud.filter((z) => z > relative);
  return { z: kept.length > 0 ? meanOf(kept) : 0, kept };
}

/** A sample in [-1,1] to a signed byte, which is all a picture of a waveform needs. */
function toInt8(value: number): number {
  return Math.max(-127, Math.min(127, Math.round(value * 127)));
}

/**
 * A waveform decimated to `count` points, each the most extreme sample of its bucket.
 *
 * Plain decimation — every Nth sample — aliases: a 5 kHz tone read every 128th sample at 48 kHz
 * draws whatever the beat between the two rates happens to be, which is a picture of the arithmetic
 * rather than of the audio. Keeping the sample furthest from zero preserves the envelope and the
 * transients, which is what a scope is read for.
 */
function decimatePeaks(samples: Float64Array, count: number): Int8Array {
  const points = new Int8Array(count);
  const bucket = samples.length / count;
  for (let i = 0; i < count; i += 1) {
    const from = Math.floor(i * bucket);
    const to = Math.min(samples.length, Math.floor((i + 1) * bucket));
    let extreme = 0;
    for (let j = from; j < to; j += 1) {
      const value = samples[j]!;
      if (Math.abs(value) > Math.abs(extreme)) extreme = value;
    }
    points[i] = toInt8(extreme);
  }
  return points;
}

/** Map a linear amplitude in [0,1] to a u16 over a [-60,0] dB window. */
function ampToU16(amp: number): number {
  if (amp <= 0) return 0;
  const db = 20 * Math.log10(amp);
  const norm = Math.max(0, Math.min(1, (db - DB_FLOOR) / -DB_FLOOR));
  return Math.round(norm * U16_MAX);
}

/** Convert a frequency to a MIDI note in 8.8 fixed-point (clamped to u16). */
function freqToMidiQ88(freq: number): number {
  if (freq <= 0) return 0;
  const midi = 69 + 12 * Math.log2(freq / 440);
  return Math.max(0, Math.min(U16_MAX, Math.round(midi * 256)));
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

/** Hz -> position in the display scale's own domain. */
function hzToScale(scale: SpectrumScale, hz: number): number {
  if (scale === 'mel') return hzToMel(hz);
  if (scale === 'log') return Math.log(hz);
  return hz;
}

/** The inverse, used to place each display bin's *edges* back on the frequency axis. */
function scaleToHz(scale: SpectrumScale, position: number): number {
  if (scale === 'mel') return melToHz(position);
  if (scale === 'log') return Math.exp(position);
  return position;
}

/** In-place iterative radix-2 Cooley-Tukey FFT (indices are always in-bounds). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wpr = Math.cos(ang);
    const wpi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < half; k += 1) {
        const a = i + k;
        const b = a + half;
        const ar = re[a]!;
        const ai = im[a]!;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = ar - tr;
        im[b] = ai - ti;
        re[a] = ar + tr;
        im[a] = ai + ti;
        const nwr = wr * wpr - wi * wpi;
        wi = wr * wpi + wi * wpr;
        wr = nwr;
      }
    }
  }
}

export class AudioMeter {
  private readonly opts: AudioMeterOptions;
  private readonly bytesPerSample: number;
  private readonly frameBytes: number; // bytes per multi-channel sample
  /** Samples per analysis window at this stream's rate; see windowSizeFor. */
  private readonly windowSize: number;
  /** The mono (mid) signal, for everything that needs a waveform: FFT, pitch. */
  private readonly ring: Float64Array;
  /** Per-frame mean of squares across channels, for everything that needs a level. */
  private readonly ringPow: Float64Array;
  /**
   * Per-frame squares of the first two channels, kept only when a stereo meter asked for them.
   * The mid mix cancels width and the mean power hides it; a stereo meter is the one consumer
   * that wants each side raw.
   */
  private readonly ringPowL: Float64Array | null;
  private readonly ringPowR: Float64Array | null;
  /**
   * The front pair's *raw* samples, kept only for the readings that need the waveform itself.
   *
   * Levels can be had from the powers above, but a correlation needs the sign, an inter-sample peak
   * needs the shape between samples, and a goniometer draws the two channels against each other.
   * Float32 rather than Float64 on purpose: its 24-bit mantissa holds a 24-bit sample exactly, which
   * is the deepest audio this server carries, and it halves the memory a 16k window costs.
   */
  private readonly ringL: Float32Array | null;
  private readonly ringR: Float32Array | null;
  private ringFilled = 0;
  private ringPos = 0;
  private readonly emitIntervalUs: number;
  private lastEmitTs: number | null = null;
  private readonly hann: Float64Array;
  /**
   * Per-display-bin FFT plan: the inclusive FFT-bin range the band covers, or an
   * empty range (hi < lo) plus a fractional bin to read by interpolation. See the
   * constructor for why both cases exist.
   */
  private readonly dispLoK: Int32Array | null;
  private readonly dispHiK: Int32Array | null;
  private readonly dispCenterK: Float64Array | null;
  private readonly spectrumState: Float64Array | null;
  private lastSpectrumTs: number | null = null;
  // Onset-detector state.
  private emaEnergy = 0;
  private lastPeakTs: number | null = null;
  // Pitch autocorrelation lag bounds.
  private readonly pitchMinLag: number;
  private readonly pitchMaxLag: number;
  /*
   * The loudness meter's state, which is the one thing here that is not about a window.
   *
   * Everything else in this class reads the last ~43 ms; R128 is a *running* measurement — the
   * K-weighting filters carry history from sample to sample and the integrated figure is over
   * everything since the meter was reset. So the filters, the block accumulator and the filed blocks
   * all live for the length of the stream, and `reset` is what a track change calls.
   */
  private readonly kShelf: Biquad[] | null;
  private readonly kHighPass: Biquad[] | null;
  private readonly ebuSubBlockFrames: number;
  private ebuAcc = 0;
  private ebuAccFrames = 0;
  /** The last 30 sub-blocks (3 s), newest last: momentary and short-term are means over its tail. */
  private ebuRecent: number[] = [];
  /** Every 400 ms block, one per 100 ms step — what the integrated reading gates over. */
  private ebuBlocks: number[] = [];
  /** Every 3 s block, one per second — what the loudness range gates over. */
  private ebuShortBlocks: number[] = [];
  private ebuSubBlockCount = 0;
  private ebuGated: { integrated: number | null; range: number | null; atUs: number } | null = null;
  /** True-peak reconstruction kernel and the running full-scale count. */
  private readonly tpKernel: Float64Array | null;
  private clipCount = 0;
  /** The running mean of the mid signal — see `DC_AVERAGE_SEC`. */
  private dc = 0;
  private readonly dcAlpha: number;

  constructor(options: AudioMeterOptions) {
    this.opts = options;
    this.bytesPerSample = Math.max(1, Math.floor(options.bitDepth / 8));
    this.frameBytes = this.bytesPerSample * Math.max(1, options.channels);
    this.emitIntervalUs = Math.floor(1_000_000 / Math.max(1, options.rateMax));
    const window = windowSizeFor(options.sampleRate);
    this.windowSize = window;
    this.ring = new Float64Array(window);
    this.ringPow = new Float64Array(window);
    const wantStereo = options.emitStereo === true && !!options.onStereo;
    this.ringPowL = wantStereo ? new Float64Array(window) : null;
    this.ringPowR = wantStereo ? new Float64Array(window) : null;
    const wantRaw =
      (options.emitCorrelation === true && !!options.onCorrelation) ||
      (options.emitTruePeak === true && !!options.onTruePeak) ||
      (options.emitGonio === true && !!options.onGonio);
    this.ringL = wantRaw ? new Float32Array(window) : null;
    this.ringR = wantRaw ? new Float32Array(window) : null;
    this.tpKernel = options.emitTruePeak === true && !!options.onTruePeak ? truePeakKernel() : null;

    const wantEbu = options.emitEbu === true && !!options.onEbu;
    const channels = Math.max(1, options.channels);
    this.kShelf = wantEbu
      ? Array.from({ length: channels }, () => shelfBiquad(options.sampleRate))
      : null;
    this.kHighPass = wantEbu
      ? Array.from({ length: channels }, () => highPassBiquad(options.sampleRate))
      : null;
    this.ebuSubBlockFrames = Math.max(1, Math.round((options.sampleRate * EBU_SUBBLOCK_MS) / 1000));
    this.dcAlpha = 1 / Math.max(1, options.sampleRate * DC_AVERAGE_SEC);
    this.hann = new Float64Array(window);
    for (let i = 0; i < window; i += 1) {
      this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (window - 1));
    }

    /*
     * Bin plan, computed per *display* bin rather than per FFT bin.
     *
     * The obvious direction — walk the usable FFT bins and drop each into the display bin
     * its frequency falls in — silently loses bars. A log scale packs its bins closest
     * together at the bottom: 48 bins over 40 Hz–16 kHz makes the first one 5.3 Hz wide,
     * where the FFT resolves ~21 Hz. Several low display bins therefore
     * contain no FFT bin at all, and a map built in that direction leaves them at zero
     * forever — measured as 5 of 48 bars that could never light up, in exactly the octaves
     * where music has the most energy.
     *
     * So each display bin states what it needs instead: the FFT bins inside its band when
     * it is wider than the resolution (take the loudest — a band an octave wide at 16 kHz
     * spans 77 bins, and averaging them would make a treble tone read ~19 dB quieter than
     * the same tone in the bass), or, when the band is narrower than a single FFT bin, the
     * magnitude *at* its centre frequency, interpolated between the two bins around it.
     */
    const spectrum = options.spectrum;
    if (spectrum && spectrum.n_disp_bins > 0) {
      const nyquist = options.sampleRate / 2;
      const fMin = Math.max(1, Math.min(spectrum.f_min, nyquist - 1));
      const fMax = Math.max(fMin + 1, Math.min(spectrum.f_max, nyquist));
      const hzPerBin = options.sampleRate / window;
      const maxK = window / 2;
      const n = spectrum.n_disp_bins;
      const scaleLo = hzToScale(spectrum.scale, fMin);
      const scaleHi = hzToScale(spectrum.scale, fMax);
      const at = (fraction: number): number =>
        scaleToHz(spectrum.scale, scaleLo + (scaleHi - scaleLo) * fraction);
      this.dispLoK = new Int32Array(n);
      this.dispHiK = new Int32Array(n);
      this.dispCenterK = new Float64Array(n);
      for (let i = 0; i < n; i += 1) {
        // First FFT bin at or above the lower edge, last one strictly below the upper edge:
        // adjacent bands neither overlap nor skip a bin.
        const lo = Math.max(1, Math.ceil(at(i / n) / hzPerBin));
        const hi = Math.min(maxK, Math.ceil(at((i + 1) / n) / hzPerBin) - 1);
        this.dispLoK[i] = lo;
        this.dispHiK[i] = hi;
        // Clamped so the interpolation always has a k+1 to reach for.
        this.dispCenterK[i] = Math.max(1, Math.min(maxK - 1, at((i + 0.5) / n) / hzPerBin));
      }
      this.spectrumState = new Float64Array(n);
    } else {
      this.dispLoK = null;
      this.dispHiK = null;
      this.dispCenterK = null;
      this.spectrumState = null;
    }

    this.pitchMinLag = Math.max(1, Math.floor(options.sampleRate / PITCH_F_MAX));
    this.pitchMaxLag = Math.min(window - 1, Math.ceil(options.sampleRate / PITCH_F_MIN));
  }

  /** One channel's sample at a byte offset, as a float in [-1,1]. */
  private readChannel(buf: Buffer, offset: number): number {
    if (this.bytesPerSample === 2) {
      return buf.readInt16LE(offset) / 32768;
    }
    if (this.bytesPerSample === 3) {
      const raw = buf.readUIntLE(offset, 3);
      return (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608;
    }
    if (this.bytesPerSample === 4) {
      return buf.readInt32LE(offset) / 2147483648;
    }
    return (buf.readUInt8(offset) - 128) / 128;
  }

  /**
   * Feed one PCM audio frame; emits visualizer frames paced to rate_max.
   *
   * Two values are kept per audio frame. The mid mix (the channel average) is the signal
   * to analyse: it is what the FFT and the pitch autocorrelation need. It is the wrong
   * thing to measure a *level* with, though — averaging amplitudes cancels anything the
   * channels carry in opposite phase, so a deliberately wide stereo mix read quiet and its
   * onsets went undetected. The level therefore comes from the mean of the channel squares,
   * which no phase relationship can cancel.
   */
  push(pcm: Buffer, frameTsUs: number): void {
    const usable = pcm.length - (pcm.length % this.frameBytes);
    const ch = Math.max(1, this.opts.channels);
    for (let off = 0; off < usable; off += this.frameBytes) {
      let sum = 0;
      let sumSq = 0;
      let sq0 = 0;
      let sq1 = 0;
      let v0 = 0;
      let v1 = 0;
      /* One weighted mean square across the channels, for the loudness meter's current sub-block. */
      let kSum = 0;
      for (let c = 0; c < ch; c += 1) {
        const v = this.readChannel(pcm, off + c * this.bytesPerSample);
        sum += v;
        sumSq += v * v;
        if (c === 0) {
          sq0 = v * v;
          v0 = v;
        } else if (c === 1) {
          sq1 = v * v;
          v1 = v;
        }
        if (this.tpKernel !== null && Math.abs(v) >= CLIP_THRESHOLD) {
          this.clipCount += 1;
        }
        if (this.kShelf && this.kHighPass) {
          const shelf = this.kShelf[c];
          const highPass = this.kHighPass[c];
          if (shelf && highPass) {
            const weighted = biquad(highPass, biquad(shelf, v));
            kSum += channelWeight(c) * weighted * weighted;
          }
        }
      }
      const mid = sum / ch;
      this.ring[this.ringPos] = mid;
      this.dc += (mid - this.dc) * this.dcAlpha;
      this.ringPow[this.ringPos] = sumSq / ch;
      if (this.ringPowL && this.ringPowR) {
        this.ringPowL[this.ringPos] = sq0;
        // Mono has one honest answer for both sides — not a silent right channel.
        this.ringPowR[this.ringPos] = ch > 1 ? sq1 : sq0;
      }
      if (this.ringL && this.ringR) {
        this.ringL[this.ringPos] = v0;
        this.ringR[this.ringPos] = ch > 1 ? v1 : v0;
      }
      if (this.kShelf) {
        this.ebuAcc += kSum;
        this.ebuAccFrames += 1;
        if (this.ebuAccFrames >= this.ebuSubBlockFrames) {
          this.fileSubBlock(this.ebuAcc / this.ebuAccFrames);
          this.ebuAcc = 0;
          this.ebuAccFrames = 0;
        }
      }
      this.ringPos = (this.ringPos + 1) % this.windowSize;
      if (this.ringFilled < this.windowSize) this.ringFilled += 1;
    }

    if (this.ringFilled < this.windowSize) return;
    if (this.lastEmitTs !== null && frameTsUs - this.lastEmitTs < this.emitIntervalUs) return;
    this.lastEmitTs = frameTsUs;
    this.emit(frameTsUs);
  }

  private emit(timestampUs: number): void {
    const o = this.opts;
    // Copy the ring into chronological order; sum the channel powers over the same window.
    const window = this.windowSize;
    const win = new Float64Array(window);
    /* The front pair in chronological order, for the readings that need the waveform itself. */
    const raw = this.ringL && this.ringR;
    const winL = raw ? new Float32Array(window) : null;
    const winR = raw ? new Float32Array(window) : null;
    let powSum = 0;
    let powSumL = 0;
    let powSumR = 0;
    /* Sums for the correlation coefficient, accumulated in the copy rather than in a second pass. */
    let sumLR = 0;
    let sumLL = 0;
    let sumRR = 0;

    for (let i = 0; i < window; i += 1) {
      const at = (this.ringPos + i) % window;
      win[i] = this.ring[at]!;
      powSum += this.ringPow[at]!;
      if (this.ringPowL && this.ringPowR) {
        powSumL += this.ringPowL[at]!;
        powSumR += this.ringPowR[at]!;
      }
      if (winL && winR && this.ringL && this.ringR) {
        const l = this.ringL[at]!;
        const r = this.ringR[at]!;
        winL[i] = l;
        winR[i] = r;
        sumLR += l * r;
        sumLL += l * l;
        sumRR += r * r;
      }
    }
    const rms = Math.sqrt(powSum / window);

    if (o.emitLoudness && o.onLoudness) {
      o.onLoudness(ampToU16(rms), timestampUs);
    }

    if (this.ringPowL && o.onStereo) {
      o.onStereo(
        ampToU16(Math.sqrt(powSumL / window)),
        ampToU16(Math.sqrt(powSumR / window)),
        timestampUs,
      );
    }

    if (o.emitPeak && o.onPeak) {
      this.detectPeak(powSum, timestampUs);
    }

    /*
     * Phase correlation: how much of the two channels is the same signal.
     *
     * +1 is mono, 0 is unrelated, −1 is one side inverted — the reading that catches a miswired
     * speaker or a mix that will collapse when a room sums it. Silence has no correlation to report
     * and gets +1 rather than a number that walks around the dial on noise: with nothing playing the
     * denominator is dust and the coefficient becomes meaningless long before it becomes wrong.
     */
    if (o.emitCorrelation && o.onCorrelation) {
      const denominator = Math.sqrt(sumLL * sumRR);
      const value = denominator > 1e-12 ? sumLR / denominator : 1;
      o.onCorrelation(Math.max(-1, Math.min(1, value)), this.dc, timestampUs);
    }

    if (this.tpKernel && winL && winR && o.onTruePeak) {
      o.onTruePeak(
        this.truePeakOf(winL),
        this.truePeakOf(winR),
        this.clipCount,
        timestampUs,
      );
    }

    if (this.kShelf && o.onEbu) {
      o.onEbu(this.ebuReading(timestampUs), timestampUs);
    }

    if (o.emitScope && o.onScope) {
      o.onScope(decimatePeaks(win, SCOPE_POINTS), timestampUs);
    }

    /*
     * The goniometer's dots, plainly decimated rather than peak-picked.
     *
     * A Lissajous figure is about *where the pairs sit*, so every dot has to be a real (L, R) pair
     * from one instant. Taking the loudest sample of each bucket per channel — which is right for a
     * scope trace — would pair a left peak with a right sample from a different moment and draw a
     * figure the audio never made.
     */
    if (o.emitGonio && o.onGonio && winL && winR) {
      const stride = Math.max(1, Math.floor(window / GONIO_POINTS));
      const points = new Int8Array(GONIO_POINTS * 2);
      for (let i = 0; i < GONIO_POINTS; i += 1) {
        const at = i * stride;
        points[i * 2] = toInt8(winL[at] ?? 0);
        points[i * 2 + 1] = toInt8(winR[at] ?? 0);
      }
      o.onGonio(points, timestampUs);
    }

    const wantSpectrum = !!(this.spectrumState && o.onSpectrum && o.spectrum);
    const wantFpeak = !!(o.emitFpeak && o.onFpeak);
    const wantPitch = !!(o.emitPitch && o.onPitch);
    if (!wantSpectrum && !wantFpeak && !wantPitch) {
      return;
    }

    // One windowed FFT shared by spectrum, f_peak and pitch.
    const re = new Float64Array(window);
    const im = new Float64Array(window);
    for (let i = 0; i < window; i += 1) re[i] = win[i]! * this.hann[i]!;
    fft(re, im);

    if (wantSpectrum) this.emitSpectrum(re, im, timestampUs);
    if (wantFpeak) this.emitFpeak(re, im, timestampUs);
    if (wantPitch) this.emitPitch(re, im, rms, timestampUs);
  }

  /**
   * The inter-sample peak of one channel's window, in dBTP.
   *
   * Reconstructed only around the loudest samples — see the note on `TP_CANDIDATE_DB`. The sample
   * peak is the floor of the answer by construction, so a channel whose loudest moment happens to
   * land exactly on a sample still reads correctly rather than reading low.
   */
  private truePeakOf(samples: Float32Array): number {
    const kernel = this.tpKernel;
    const length = samples.length;
    let samplePeak = 0;
    for (let i = 0; i < length; i += 1) {
      const magnitude = Math.abs(samples[i]!);
      if (magnitude > samplePeak) samplePeak = magnitude;
    }
    if (samplePeak <= 0) {
      return -Infinity;
    }
    let peak = samplePeak;
    if (kernel) {
      const threshold = samplePeak * 10 ** (-TP_CANDIDATE_DB / 20);
      let candidates = 0;
      for (let i = 0; i < length && candidates < TP_MAX_CANDIDATES; i += 1) {
        if (Math.abs(samples[i]!) < threshold) continue;
        candidates += 1;
        for (let phase = 1; phase < TP_OVERSAMPLE; phase += 1) {
          let value = 0;
          for (let tap = 0; tap < TP_TAPS; tap += 1) {
            const at = i - TP_CENTER + tap;
            // Outside the window the signal is unknown, not zero — but a zero tap only ever
            // *lowers* the reconstruction, and the sample peak already floors the answer.
            if (at < 0 || at >= length) continue;
            value += kernel[phase * TP_TAPS + tap]! * samples[at]!;
          }
          const magnitude = Math.abs(value);
          if (magnitude > peak) peak = magnitude;
        }
      }
    }
    return 20 * Math.log10(peak);
  }

  /**
   * File one 100 ms sub-block and, with it, whatever longer windows it completes.
   *
   * The grid is the standard's: a 400 ms block every 100 ms (75% overlap) for the integrated
   * reading, and a 3 s block every second for the range. Both are *means of sub-blocks* rather than
   * separate accumulators, which is what keeps the four readings on this meter arithmetically
   * consistent with each other.
   */
  private fileSubBlock(z: number): void {
    this.ebuRecent.push(z);
    if (this.ebuRecent.length > EBU_SHORT_SUBBLOCKS) {
      this.ebuRecent.shift();
    }
    this.ebuSubBlockCount += 1;

    if (this.ebuRecent.length >= EBU_MOMENTARY_SUBBLOCKS && this.ebuBlocks.length < EBU_MAX_BLOCKS) {
      this.ebuBlocks.push(meanOf(this.ebuRecent, this.ebuRecent.length - EBU_MOMENTARY_SUBBLOCKS));
    }

    if (
      this.ebuRecent.length >= EBU_SHORT_SUBBLOCKS &&
      this.ebuSubBlockCount % EBU_RANGE_STEP_SUBBLOCKS === 0 &&
      this.ebuShortBlocks.length < EBU_MAX_BLOCKS
    ) {
      this.ebuShortBlocks.push(meanOf(this.ebuRecent));
    }
  }

  /**
   * The four R128 readings.
   *
   * Momentary and short-term are recomputed every frame — they are a tail of at most thirty numbers.
   * The gated pair is not: it walks every block since the reset, and at three hours that is a hundred
   * thousand of them for a figure that moves in the third decimal. So it is recomputed a few times a
   * second and held in between, which is also how a hardware meter behaves.
   */
  private ebuReading(timestampUs: number): EbuLoudness {
    const recent = this.ebuRecent;
    const momentary =
      recent.length >= EBU_MOMENTARY_SUBBLOCKS
        ? lufsOf(meanOf(recent, recent.length - EBU_MOMENTARY_SUBBLOCKS))
        : null;
    const shortTerm = recent.length >= EBU_SHORT_SUBBLOCKS ? lufsOf(meanOf(recent)) : null;

    const stale =
      this.ebuGated === null || timestampUs - this.ebuGated.atUs >= EBU_GATED_INTERVAL_US;
    if (stale) {
      const integrated = lufsOf(gate(this.ebuBlocks, GATE_RELATIVE_LU).z);
      const spread = gate(this.ebuShortBlocks, RANGE_RELATIVE_LU).kept;
      let range: number | null = null;
      if (spread.length >= 2) {
        const sorted = [...spread].sort((a, b) => a - b);
        const at = (fraction: number): number =>
          sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))]!;
        const low = lufsOf(at(RANGE_LOW_PERCENTILE));
        const high = lufsOf(at(RANGE_HIGH_PERCENTILE));
        range = low !== null && high !== null ? high - low : null;
      }
      this.ebuGated = { integrated, range, atUs: timestampUs };
    }

    return {
      momentary,
      shortTerm,
      integrated: this.ebuGated?.integrated ?? null,
      range: this.ebuGated?.range ?? null,
    };
  }

  /**
   * Start the running measurements over — a new track, not a new format.
   *
   * A format change rebuilds this object entirely (the filters and the bin plan are tuned to the
   * rate), so this exists for the other boundary: an integrated loudness that carried across a track
   * change would describe the album, and a clip count that did would describe the evening. The
   * window rings are deliberately *not* cleared: they hold the last 43 ms of audio, which belongs to
   * whatever is playing now either way, and emptying them would blank the spectrum for a frame.
   */
  public reset(): void {
    if (this.kShelf) {
      for (const stage of this.kShelf) resetBiquad(stage);
    }
    if (this.kHighPass) {
      for (const stage of this.kHighPass) resetBiquad(stage);
    }
    this.ebuAcc = 0;
    this.ebuAccFrames = 0;
    this.ebuRecent = [];
    this.ebuBlocks = [];
    this.ebuShortBlocks = [];
    this.ebuSubBlockCount = 0;
    this.ebuGated = null;
    this.clipCount = 0;
    this.dc = 0;
  }

  private emitSpectrum(re: Float64Array, im: Float64Array, timestampUs: number): void {
    const n = this.opts.spectrum!.n_disp_bins;
    const state = this.spectrumState!;
    const loK = this.dispLoK!;
    const hiK = this.dispHiK!;
    const centerK = this.dispCenterK!;
    // Full-scale normalization: a unit sine through a Hann window peaks near N/4.
    const norm = this.windowSize / 4;
    // Wall-clock decay, so the fall time does not follow the client's frame rate. A
    // timestamp that did not advance (or jumped backwards on a seek) starts clean.
    const elapsedMs =
      this.lastSpectrumTs === null ? Infinity : (timestampUs - this.lastSpectrumTs) / 1000;
    this.lastSpectrumTs = timestampUs;
    const decay = elapsedMs > 0 ? 2 ** (-elapsedMs / SPECTRUM_HALFLIFE_MS) : 0;

    const out = new Uint16Array(n);
    for (let i = 0; i < n; i += 1) {
      const lo = loK[i]!;
      const hi = hiK[i]!;
      let mag: number;
      if (hi >= lo) {
        let peakPower = 0;
        for (let k = lo; k <= hi; k += 1) {
          const power = re[k]! * re[k]! + im[k]! * im[k]!;
          if (power > peakPower) peakPower = power;
        }
        mag = Math.sqrt(peakPower) / norm;
      } else {
        // Band narrower than one FFT bin: read the magnitude at its centre frequency.
        const kf = centerK[i]!;
        const k0 = Math.floor(kf);
        const t = kf - k0;
        const m0 = Math.hypot(re[k0]!, im[k0]!);
        const m1 = Math.hypot(re[k0 + 1]!, im[k0 + 1]!);
        mag = (m0 + (m1 - m0) * t) / norm;
      }
      const value = Math.max(mag, state[i]! * decay);
      state[i] = value;
      out[i] = ampToU16(value);
    }
    this.opts.onSpectrum!(out, timestampUs);
  }

  /** Dominant FFT bin with parabolic sub-bin interpolation. */
  private emitFpeak(re: Float64Array, im: Float64Array, timestampUs: number): void {
    const half = this.windowSize / 2;
    let bestK = 1;
    let bestMag = -1;
    for (let k = 1; k < half; k += 1) {
      const mag = re[k]! * re[k]! + im[k]! * im[k]!;
      if (mag > bestMag) {
        bestMag = mag;
        bestK = k;
      }
    }
    const a = Math.hypot(re[bestK - 1]!, im[bestK - 1]!);
    const b = Math.hypot(re[bestK]!, im[bestK]!);
    const c = Math.hypot(re[bestK + 1] ?? 0, im[bestK + 1] ?? 0);
    const denom = a - 2 * b + c;
    const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const freq = ((bestK + delta) * this.opts.sampleRate) / this.windowSize;
    const amp = ampToU16(b / (this.windowSize / 4));
    this.opts.onFpeak!(Math.round(freq), amp, timestampUs);
  }

  /** Energy-onset detector against a running mean. */
  private detectPeak(energy: number, timestampUs: number): void {
    if (this.emaEnergy <= 0) {
      this.emaEnergy = energy;
      return;
    }
    const ratio = energy / this.emaEnergy;
    const recentEnough =
      this.lastPeakTs === null || timestampUs - this.lastPeakTs >= PEAK_MIN_GAP_US;
    if (ratio >= PEAK_THRESHOLD && recentEnough) {
      this.lastPeakTs = timestampUs;
      const strength = Math.max(0, Math.min(255, Math.round((ratio - 1) * 96)));
      this.opts.onPeak!(strength, timestampUs);
    }
    this.emaEnergy = this.emaEnergy * PEAK_EMA + energy * (1 - PEAK_EMA);
  }

  /**
   * Pitch via autocorrelation: r = IFFT(|X|^2), found as the real part of an
   * FFT of the power spectrum. The best lag in the pitch range gives the
   * period; normalized peak height is the confidence.
   */
  private emitPitch(re: Float64Array, im: Float64Array, rms: number, timestampUs: number): void {
    if (rms < PITCH_RMS_GATE) return;
    const power = new Float64Array(this.windowSize);
    const zero = new Float64Array(this.windowSize);
    for (let k = 0; k < this.windowSize; k += 1) power[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    // |X|^2 is real and even, so FFT(power).re == IFFT(power)*N == autocorrelation*N.
    fft(power, zero);
    const r0 = power[0]!;
    if (r0 <= 0) return;
    let bestLag = -1;
    let bestVal = 0;
    for (let lag = this.pitchMinLag; lag <= this.pitchMaxLag; lag += 1) {
      const v = power[lag]!;
      if (v > bestVal) {
        bestVal = v;
        bestLag = lag;
      }
    }
    if (bestLag < 1) return;
    const confidence = bestVal / r0;
    if (confidence < PITCH_MIN_CONFIDENCE) return;
    // Parabolic interpolation around the autocorrelation peak for sub-sample lag.
    const a = power[bestLag - 1]!;
    const b = power[bestLag]!;
    const c = power[bestLag + 1] ?? 0;
    const denom = a - 2 * b + c;
    const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const freq = this.opts.sampleRate / (bestLag + delta);
    this.opts.onPitch!(freqToMidiQ88(freq), Math.round(Math.min(1, confidence) * 255), timestampUs);
  }
}
