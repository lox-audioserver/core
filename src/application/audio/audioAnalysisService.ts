/**
 * Live analysis of what a zone is playing, as the sendspin visualizer@v1 events.
 *
 * `loudness`, `spectrum`, `f_peak` and `stereo` are u16 *positions in dB*, not amplitudes — the
 * window they span is `ANALYSIS_DB_FLOOR`…0 dBFS in `@/domain/audio/analysisScale`, which is also
 * where the conversion is written down. Read it before touching any of these values.
 */

export type AudioAnalysisEvent =
  | { type: 'loudness'; value: number; timestampUs: number }
  | { type: 'spectrum'; bins: Uint16Array; timestampUs: number }
  | { type: 'f_peak'; frequencyHz: number; amplitude: number; timestampUs: number }
  | { type: 'peak'; strength: number; timestampUs: number }
  | { type: 'pitch'; midiQ88: number; confidence: number; timestampUs: number }
  /** Front left/right levels in the same u16 dB encoding as `loudness`. Mono reports both equal. */
  | { type: 'stereo'; left: number; right: number; timestampUs: number }
  /**
   * The readings below are *not* u16 dB positions — they are the units a person reads.
   *
   * The visualizer@v1 encoding exists so a small client can draw bars without doing arithmetic; a
   * loudness in LUFS or a peak in dBTP is a number to *print*, and re-encoding it into a 16-bit
   * window would throw away the sign and the precision that make it worth printing.
   */
  | { type: 'correlation'; value: number; dcOffset: number; timestampUs: number }
  /** Inter-sample peak per side in dBTP (−Infinity when silent), and full-scale samples so far. */
  | { type: 'truepeak'; leftDb: number; rightDb: number; clips: number; timestampUs: number }
  /** EBU R128, in LUFS and LU. Any field is null until enough audio has passed to state it. */
  | {
      type: 'ebu';
      momentary: number | null;
      shortTerm: number | null;
      integrated: number | null;
      range: number | null;
      timestampUs: number;
    }
  /** A decimated waveform of the analysis window, signed bytes. */
  | { type: 'scope'; points: Int8Array; timestampUs: number }
  /** Front-pair sample pairs, interleaved L,R as signed bytes. */
  | { type: 'gonio'; points: Int8Array; timestampUs: number };

export type AudioAnalysisSubscription = {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  rateMax: number;
  /** Which PCM timeline feeds this consumer. Engine time is used by the API. */
  feed?: 'engine' | 'scheduled-output';
  loudness?: boolean;
  fPeak?: boolean;
  peak?: boolean;
  pitch?: boolean;
  stereo?: boolean;
  correlation?: boolean;
  truePeak?: boolean;
  ebu?: boolean;
  scope?: boolean;
  gonio?: boolean;
  spectrum?: {
    n_disp_bins: number;
    scale: 'lin' | 'log' | 'mel';
    f_min: number;
    f_max: number;
  };
};

export type AudioAnalysisListener = (event: AudioAnalysisEvent) => void;

export type AudioAnalysisAnalyzer = {
  push: (pcm: Buffer, timestampUs: number) => void;
  /**
   * Start over any measurement that is *running* rather than windowed.
   *
   * Optional because most analyzers have none: everything derived from one 43 ms window is already
   * about whatever is playing now. The loudness integrator and the clip count are the exceptions —
   * they describe a programme, and a programme ends when the track does.
   */
  reset?: () => void;
};
export type AudioAnalysisAnalyzerFactory = (
  options: AudioAnalysisSubscription,
  listener: AudioAnalysisListener,
) => AudioAnalysisAnalyzer;

type Subscription = {
  analyzer: AudioAnalysisAnalyzer;
  feed: 'engine' | 'scheduled-output';
};

/**
 * Asked to arrange PCM for a zone that has consumers but no producer.
 *
 * Outputs that run a PCM session push frames of their own accord; the rest need something to go and
 * fetch the audio. That is a decision about *sessions*, which this service knows nothing about, so it
 * only reports the transitions: first engine-feed consumer for a zone, and last one gone.
 */
export interface AudioAnalysisFeedController {
  ensure(zoneId: number): void;
  release(zoneId: number): void;
}

/**
 * Protocol-neutral owner of realtime audio analysis.
 *
 * Outputs feed PCM into this service and subscribe to normalized events. A future web/API
 * consumer can subscribe here without making the analysis implementation depend on Sendspin.
 * No analyzer exists until a consumer subscribes.
 */
export class AudioAnalysisService {
  private readonly subscriptions = new Map<number, Map<symbol, Subscription>>();
  private feedController: AudioAnalysisFeedController | null = null;

  constructor(private readonly createAnalyzer: AudioAnalysisAnalyzerFactory) {}

  /**
   * Wire the thing that produces PCM for outputs which do not push it themselves. Set once during
   * bootstrap; without it the service behaves exactly as before and only sees what outputs push.
   */
  public setFeedController(controller: AudioAnalysisFeedController | null): void {
    this.feedController = controller;
  }

  /**
   * Tell a zone's analyzers that a new programme has started.
   *
   * Called at a track boundary, which is a thing this service is not otherwise aware of — it sees
   * PCM and formats. Harmless for an analyzer that keeps no running state, which is why it is a
   * broadcast rather than something a caller has to hold a handle for.
   */
  public reset(zoneId: number): void {
    const zoneSubscriptions = this.subscriptions.get(zoneId);
    if (!zoneSubscriptions) {
      return;
    }
    for (const subscription of zoneSubscriptions.values()) {
      subscription.analyzer.reset?.();
    }
  }

  public subscribe(
    zoneId: number,
    options: AudioAnalysisSubscription,
    listener: AudioAnalysisListener,
  ): () => void {
    const token = Symbol(`audio-analysis-${zoneId}`);
    const analyzer = this.createAnalyzer(options, listener);
    let zoneSubscriptions = this.subscriptions.get(zoneId);
    if (!zoneSubscriptions) {
      zoneSubscriptions = new Map();
      this.subscriptions.set(zoneId, zoneSubscriptions);
    }
    const feed = options.feed ?? 'engine';
    zoneSubscriptions.set(token, { analyzer, feed });
    if (feed === 'engine' && this.engineConsumers(zoneId) === 1) {
      this.feedController?.ensure(zoneId);
    }
    return () => {
      const current = this.subscriptions.get(zoneId);
      if (!current?.delete(token)) {
        return;
      }
      if (feed === 'engine' && this.engineConsumers(zoneId) === 0) {
        this.feedController?.release(zoneId);
      }
      if (current.size === 0) {
        this.subscriptions.delete(zoneId);
      }
    };
  }

  private engineConsumers(zoneId: number): number {
    let count = 0;
    for (const subscription of this.subscriptions.get(zoneId)?.values() ?? []) {
      if (subscription.feed === 'engine') {
        count += 1;
      }
    }
    return count;
  }

  public push(
    zoneId: number,
    pcm: Buffer,
    timestampUs: number,
    feed: 'engine' | 'scheduled-output' = 'engine',
  ): void {
    const zoneSubscriptions = this.subscriptions.get(zoneId);
    if (!zoneSubscriptions) {
      return;
    }
    for (const subscription of zoneSubscriptions.values()) {
      if (subscription.feed === feed) {
        subscription.analyzer.push(pcm, timestampUs);
      }
    }
  }
}
