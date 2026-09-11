import { RadioBrowserClient } from '@/adapters/content/providers/radiobrowser/radioBrowserClient';
import type { RadioBrowserStation } from '@/adapters/content/providers/radiobrowser/radioBrowserClient';
import type { RadioStationHit } from '@/ports/RadioAdminPort';

const SEARCH_LIMIT_DEFAULT = 25;
const SEARCH_LIMIT_MAX = 50;

const client = new RadioBrowserClient();

/**
 * Stations matching what someone typed into the custom-stream form.
 *
 * One operation, because that is the one question the screen asks — the same shape
 * `validateTuneInUsername` has, and for the same reason: the route stays a route and the
 * quirks of the index live here.
 *
 * Over-fetch and then de-duplicate: a popular station is listed many times over by
 * different submitters, often pointing at the same stream, and twenty rows of "BBC Radio 1"
 * is not a result a person can choose from.
 */
export async function searchRadioStations(
  query: string,
  limit = SEARCH_LIMIT_DEFAULT,
): Promise<RadioStationHit[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const want = Math.min(Math.max(1, Math.trunc(limit) || SEARCH_LIMIT_DEFAULT), SEARCH_LIMIT_MAX);
  const raw = await client.searchByName(trimmed, want * 3);
  const seen = new Set<string>();
  const hits: RadioStationHit[] = [];
  for (const station of raw) {
    const hit = toHit(station);
    if (!hit) {
      continue;
    }
    const key = hit.stream.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    hits.push(hit);
    if (hits.length >= want) {
      break;
    }
  }
  return hits;
}

/** Count a station that was actually taken up, so the index's ranking learns from us too. */
export async function reportRadioStationPicked(stationId: string): Promise<void> {
  await client.reportClick(stationId);
}

/**
 * The station's own url in preference to the resolved one.
 *
 * radio-browser stores both: what the station publishes, and where that led at the last
 * check. The published one is usually a `.pls` or `.m3u`, and that indirection is the
 * point — it is how a station moves servers without every listener having to re-add it.
 * Since #368 we follow those pointers ourselves, so keeping the pointer is strictly
 * better than freezing today's CDN hostname into a saved entry.
 */
function toHit(station: RadioBrowserStation): RadioStationHit | null {
  const id = station.stationuuid?.trim();
  const name = station.name?.trim();
  const stream = station.url?.trim() || station.url_resolved?.trim() || '';
  if (!id || !name || !/^https?:\/\//i.test(stream)) {
    return null;
  }
  const favicon = station.favicon?.trim();
  return {
    id,
    name,
    stream,
    // A favicon is whatever a submitter typed years ago: often empty, sometimes a
    // 16-pixel icon, frequently a dead host. Pass on only what is at least a url and
    // let the form show it — a broken image is a visible reason to leave the field empty.
    ...(favicon && /^https?:\/\//i.test(favicon) ? { coverurl: favicon } : {}),
    ...(station.country?.trim() ? { country: station.country.trim() } : {}),
    ...(station.countrycode?.trim() ? { countryCode: station.countrycode.trim() } : {}),
    ...(station.language?.trim() ? { language: station.language.trim() } : {}),
    ...(station.codec?.trim() && station.codec.toUpperCase() !== 'UNKNOWN'
      ? { codec: station.codec.trim() }
      : {}),
    // Kilobits, except where a submitter filled the field in bits: one SomaFM listing
    // claims 320000, and "320000 kbps" next to "128 kbps" reads as a broken row rather
    // than as a better stream. Nothing above the ceiling is a bitrate worth showing.
    ...(typeof station.bitrate === 'number' && station.bitrate > 0 && station.bitrate <= 2000
      ? { bitrate: station.bitrate }
      : {}),
    votes: typeof station.votes === 'number' ? station.votes : 0,
  };
}
