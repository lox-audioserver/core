import type { Readable } from 'node:stream';

/**
 * A station the admin search offers, in the shape the custom-stream form fills itself from.
 *
 * Deliberately the fields a person choosing between two listings of the same station needs —
 * where it broadcasts, in what, and how many people voted for it — and not the forty an
 * index keeps.
 */
export interface RadioStationHit {
  /** The index's own id for the station, kept on the saved entry so it can be looked up again. */
  id: string;
  name: string;
  stream: string;
  coverurl?: string;
  country?: string;
  countryCode?: string;
  language?: string;
  codec?: string;
  bitrate?: number;
  votes: number;
}

/**
 * A stream being decoded for someone to listen to, or the reason there is nothing to hear.
 *
 * The failure is a value rather than a thrown error because it is an ordinary outcome: half
 * the point of a preview is to find out that a url does not play.
 */
export type StreamPreview =
  | {
      ok: true;
      /** mp3 bytes, already flowing: the first sample arrived before this was handed over. */
      body: Readable;
      stop(reason: string): void;
    }
  | {
      ok: false;
      error: 'preview-unplayable' | 'preview-timeout' | 'preview-spawn-failed';
      detail?: string;
    };

/**
 * Administering radio stations: finding one in the public index, and hearing one before
 * it is kept.
 *
 * One port because it is one screen's toolkit. Both operations reach outside the box — a
 * community-run index over the internet, and a decoder spawned on a stream url — which is
 * exactly what an admin route should not be doing inline.
 *
 * Everything here is a *management* operation. Nothing on this port plays to a zone.
 */
export interface RadioAdminPort {
  /**
   * Stations from the public index whose name matches, best-known first.
   *
   * Throws when the index cannot be reached: it is somebody else's server, and the screen
   * has to be able to say so rather than show an empty result as if nothing matched.
   */
  searchStations(query: string, limit?: number): Promise<RadioStationHit[]>;

  /**
   * Tell the index a station was taken up, feeding the ranking everyone reads.
   *
   * Never throws: whether the count landed changes nothing for the person who just added
   * a station.
   */
  reportStationPicked(stationId: string): Promise<void>;

  /**
   * Decode a stream url to mp3 for as long as the caller keeps reading.
   *
   * Any stream url, not only one that came out of the index — the reason to type a url by
   * hand is the same reason to want to hear it first.
   */
  openPreview(url: string): Promise<StreamPreview>;
}
