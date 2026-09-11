import { createLogger } from '@/shared/logging/logger';
import { readPackageVersion } from '@/shared/serverVersion';

/**
 * The mirror list is itself an endpoint: radio-browser has no single host, and the
 * community runs a handful of them that come and go. `all.api.radio-browser.info`
 * round-robins over whichever are up, which is exactly what we ask it for.
 */
const SERVER_LIST_URL = 'https://all.api.radio-browser.info/json/servers';
/** The mirror that has outlived every other one; used when the list cannot be read. */
const FALLBACK_HOST = 'de1.api.radio-browser.info';
const SERVER_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

const log = createLogger('Content', 'RadioBrowser');

/** One station as radio-browser stores it; only the fields we read are named. */
export interface RadioBrowserStation {
  stationuuid?: string;
  name?: string;
  /** What the station itself publishes — often a `.pls`/`.m3u` pointing at the stream. */
  url?: string;
  /** The same stream after radio-browser followed the pointer, as of its last check. */
  url_resolved?: string;
  favicon?: string;
  country?: string;
  countrycode?: string;
  language?: string;
  tags?: string;
  codec?: string;
  bitrate?: number;
  votes?: number;
  /** 1 when the last availability check reached the stream. */
  lastcheckok?: number;
}

/**
 * radio-browser's read API, as much of it as the admin search needs.
 *
 * The service is free, community-run and asks callers to identify themselves; an
 * anonymous flood is what gets an address blocked. So every request carries our name
 * and version, and nothing here is called on a playback path — this is a search box
 * a person types into, not something a zone hits.
 */
export class RadioBrowserClient {
  private readonly userAgent = `sonn-audio/${readPackageVersion()} (+https://github.com/sonn-audio/core)`;
  private host: { name: string; resolvedAt: number } | null = null;

  /**
   * Stations whose name matches, best-known first.
   *
   * `hidebroken` drops the ones whose last check failed, which is most of what makes a
   * community list feel unreliable, and ordering by votes puts the station a person
   * actually meant above the twenty re-listings of it.
   */
  public async searchByName(query: string, limit: number): Promise<RadioBrowserStation[]> {
    const params = new URLSearchParams({
      name: query,
      limit: String(limit),
      order: 'votes',
      reverse: 'true',
      hidebroken: 'true',
    });
    const body = await this.getJson(`/json/stations/search?${params.toString()}`);
    return Array.isArray(body) ? (body as RadioBrowserStation[]) : [];
  }

  /**
   * Tell radio-browser a station was taken up.
   *
   * Their popularity ranking is built from exactly this call, so a consumer that only
   * reads makes the list worse for everyone over time. Best-effort by construction:
   * whether the count landed changes nothing for the person who just added a station.
   */
  public async reportClick(stationId: string): Promise<void> {
    try {
      await this.getJson(`/json/url/${encodeURIComponent(stationId)}`);
    } catch (err) {
      log.debug('click report failed', { stationId, err });
    }
  }

  /**
   * One GET against the current mirror, retried once against the fallback.
   *
   * A mirror that disappears is the normal failure here, not a bad request — so a
   * transport error drops the cached host and tries the long-lived one before giving up.
   */
  private async getJson(path: string): Promise<unknown> {
    const host = await this.resolveHost();
    try {
      return await this.fetchJson(`https://${host}${path}`);
    } catch (err) {
      if (host === FALLBACK_HOST) {
        throw err;
      }
      log.debug('mirror failed, retrying on the fallback', { host, err });
      this.host = null;
      return this.fetchJson(`https://${FALLBACK_HOST}${path}`);
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    const res = await fetch(url, {
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`radio-browser request failed: HTTP ${res.status}`);
    }
    return res.json();
  }

  /** A mirror to talk to, remembered for an hour so a search does not cost two round trips. */
  private async resolveHost(): Promise<string> {
    const cached = this.host;
    if (cached && Date.now() - cached.resolvedAt < SERVER_TTL_MS) {
      return cached.name;
    }
    let name = FALLBACK_HOST;
    try {
      const res = await fetch(SERVER_LIST_URL, {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { name?: string }[];
        // The list holds one entry per address, so a mirror reachable over both IPv4 and
        // IPv6 appears twice under the same name. Picking at random spreads the load the
        // way the project asks callers to.
        const names = [...new Set((body ?? []).map((entry) => entry?.name).filter(Boolean))];
        if (names.length > 0) {
          name = names[Math.floor(Math.random() * names.length)] as string;
        }
      }
    } catch (err) {
      log.debug('mirror list unreachable, using the fallback', { err });
    }
    this.host = { name, resolvedAt: Date.now() };
    return name;
  }
}
