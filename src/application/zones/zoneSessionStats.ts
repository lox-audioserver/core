/**
 * What a room has been doing since the music started.
 *
 * The counters a rack instrument shows along the bottom — how long this has been running, how many
 * tracks, how many of them arrived untouched, how often the format changed under it, how often the
 * clock had to be found again. None of them existed anywhere: every one is a fact *about a sequence*
 * of zone states, and every component that sees zone states sees one at a time.
 *
 * So this is a small observer on the one signal that already carries every change, and it invents
 * nothing: each counter is a transition in state the server was already publishing. In particular
 * there is **no underrun count**, because no part of this server reports one — a dropout is currently
 * something you hear, not something anything measures, and a zero there would be a lie told steadily.
 *
 * A *run* ends when the room stops, not when it pauses. Pausing to answer the door does not start a
 * new evening, and a counter that reset on it would be describing the pause rather than the listening.
 */

/** One room's counters, as the API publishes them. */
export interface ZoneSessionCounters {
  /** Unix milliseconds when this run of playback began. */
  startedAt: number;
  /** Tracks started since then, including the one playing. */
  tracks: number;
  /** How many of those reached the output with their samples untouched. */
  bitPerfect: number;
  /** How often the stream handed to the output changed shape — rate, depth, channels or codec. */
  formatChanges: number;
  /** How often the output's clock left its lock and had to find it again. */
  clockResyncs: number;
}

/** What the observer needs from one zone state, already reduced to the parts it counts. */
export interface ZoneSessionObservation {
  playing: boolean;
  stopped: boolean;
  /** Identifies the track. Empty when the room is playing nothing identifiable. */
  trackKey: string;
  /** Identifies the shape of the stream on the wire. Empty when nothing is streaming. */
  formatKey: string;
  /** Whether the samples reach the output untouched, as far as is known right now. */
  bitPerfect: boolean;
  /** The output's own clock verdict, when it has one. */
  synchronized: boolean | null;
}

type Run = ZoneSessionCounters & {
  trackKey: string;
  formatKey: string;
  /**
   * Whether the *current* track has been seen bit-perfect yet.
   *
   * Held apart from the committed count because the verdict often arrives after the track does: the
   * format is reported once the stream has actually started, so counting at the track boundary would
   * score every track with the previous one's answer. It commits when the track changes.
   */
  currentBitPerfect: boolean;
  synchronized: boolean | null;
};

export class ZoneSessionStats {
  private readonly runs = new Map<number, Run>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  public observe(zoneId: number, observation: ZoneSessionObservation): void {
    if (observation.stopped) {
      this.runs.delete(zoneId);
      return;
    }
    if (!observation.playing && !this.runs.has(zoneId)) {
      // Paused before it ever played — nothing has begun to count.
      return;
    }

    let run = this.runs.get(zoneId);
    if (!run) {
      run = {
        startedAt: this.now(),
        tracks: observation.trackKey ? 1 : 0,
        bitPerfect: 0,
        formatChanges: 0,
        clockResyncs: 0,
        trackKey: observation.trackKey,
        formatKey: observation.formatKey,
        currentBitPerfect: observation.bitPerfect,
        synchronized: observation.synchronized,
      };
      this.runs.set(zoneId, run);
      return;
    }

    if (observation.trackKey && observation.trackKey !== run.trackKey) {
      if (run.trackKey && run.currentBitPerfect) {
        run.bitPerfect += 1;
      }
      run.tracks += 1;
      run.trackKey = observation.trackKey;
      run.currentBitPerfect = observation.bitPerfect;
    } else if (observation.bitPerfect) {
      // The verdict for the track already counted, arriving late. Once true, it stays true for
      // this track: a passthrough that is later re-negotiated shows up as a format change instead.
      run.currentBitPerfect = true;
    }

    /* Only between two known shapes. A stream starting or ending is not the format changing. */
    if (observation.formatKey && run.formatKey && observation.formatKey !== run.formatKey) {
      run.formatChanges += 1;
    }
    if (observation.formatKey) {
      run.formatKey = observation.formatKey;
    }

    if (run.synchronized === true && observation.synchronized === false) {
      run.clockResyncs += 1;
    }
    if (observation.synchronized !== null) {
      run.synchronized = observation.synchronized;
    }
  }

  /** The counters for a room, or null when nothing has been playing. */
  public get(zoneId: number): ZoneSessionCounters | null {
    const run = this.runs.get(zoneId);
    if (!run) {
      return null;
    }
    return {
      startedAt: run.startedAt,
      tracks: run.tracks,
      // The track playing right now counts as soon as its verdict is in, rather than only once it
      // has been replaced — otherwise a room playing its first bit-perfect track reads `0 of 1`.
      bitPerfect: run.bitPerfect + (run.currentBitPerfect ? 1 : 0),
      formatChanges: run.formatChanges,
      clockResyncs: run.clockResyncs,
    };
  }

  /** Forget a room entirely — it was removed from the house. */
  public forget(zoneId: number): void {
    this.runs.delete(zoneId);
  }
}
