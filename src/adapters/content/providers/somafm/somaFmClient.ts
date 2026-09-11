import { createLogger } from '@/shared/logging/logger';
import { readPackageVersion } from '@/shared/serverVersion';

const CHANNELS_URL = 'https://somafm.com/channels.json';
const REQUEST_TIMEOUT_MS = 10_000;

const log = createLogger('Content', 'SomaFM');

/** One SomaFM channel as its own feed describes it; only the fields we read are named. */
export interface SomaFmChannel {
  id?: string;
  title?: string;
  description?: string;
  genre?: string;
  /** 120, 256 and 512 pixel logos. The largest is the only one worth showing as cover art. */
  image?: string;
  largeimage?: string;
  xlimage?: string;
  /**
   * Every way to listen, in SomaFM's own order — which is uniformly mp3 first, then aac,
   * then two lower aacp rates. Their order is the preference; we do not second-guess it.
   */
  playlists?: { url?: string; format?: string; quality?: string }[];
}

/**
 * SomaFM's channel feed, fetched once in a while and kept.
 *
 * A listener-funded station that publishes one honest json file: 46 channels, each with a
 * description, a genre and logos. There is no account, no key and no per-listener call —
 * which is what makes it worth having as a provider rather than as forty-six urls someone
 * has to paste in by hand.
 *
 * The last good answer is kept through a failure. A station list that empties out because
 * somebody's wifi blinked is worse than one that is a few hours stale.
 */
export class SomaFmClient {
  private readonly userAgent = `sonn-audio/${readPackageVersion()} (+https://github.com/sonn-audio/core)`;
  private cache: { channels: SomaFmChannel[]; fetchedAt: number } | null = null;
  private inFlight: Promise<SomaFmChannel[]> | null = null;

  constructor(private readonly ttlMs = 6 * 60 * 60 * 1000) {}

  public async channels(): Promise<SomaFmChannel[]> {
    const cached = this.cache;
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) {
      return cached.channels;
    }
    // One request for however many callers arrive while it is open.
    this.inFlight ??= this.fetchChannels().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchChannels(): Promise<SomaFmChannel[]> {
    try {
      const res = await fetch(CHANNELS_URL, {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as { channels?: SomaFmChannel[] };
      const channels = Array.isArray(body?.channels) ? body.channels : [];
      if (channels.length === 0) {
        throw new Error('no channels in the feed');
      }
      this.cache = { channels, fetchedAt: Date.now() };
      return channels;
    } catch (err) {
      const stale = this.cache?.channels;
      log.warn('channel list unavailable', {
        err,
        servingStale: stale ? stale.length : 0,
      });
      return stale ?? [];
    }
  }
}
