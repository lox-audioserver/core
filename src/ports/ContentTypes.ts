import type { SpotifyAccountConfig as ConfigSpotifyAccountConfig } from '@/domain/config/types';
import type { ContentItemKind } from '@/domain/media/contentKind';

export interface ContentServiceAccount {
  id: string;
  label: string;
  provider: 'spotify' | 'applemusic' | 'musicassistant' | 'deezer' | 'tidal' | string;
  fake?: boolean;
  product?: string;
}

export interface ContentServiceEntry {
  cmd: string;
  name: string;
  icon: string;
  accounts?: ContentServiceAccount[];
}

export interface ContentFolderItem {
  id: string;
  name: string;
  type: number;
  audiopath?: string;
  coverurl?: string;
  /** Optional Apple motion-artwork video URL for clients that support it. */
  animatedCoverUrl?: string;
  items?: number;
  title?: string;
  thumbnail?: string;
  /** Neutral item kind. Preferred over {@link tag}; see {@link ContentItemKind}. */
  kind?: ContentItemKind;
  /**
   * Loxone-facing hint string ('track', 'album', 'nas', …). Kept because the Loxone
   * clients receive it verbatim; new code should read {@link kind} instead.
   */
  tag?: string;
  nas?: boolean;
  origin?: string;
  owner?: string;
  followed?: boolean;
  artist?: string;
  album?: string;
  provider?: string;
  duration?: number;
  hasCover?: boolean;
  owner_id?: string;
}

export interface ContentFolder {
  id: string;
  name: string;
  items: ContentFolderItem[];
  /**
   * How many items the folder holds in total — but see {@link ContentFolder.totalKnown}.
   *
   * Several providers cannot answer this: an upstream that pages without reporting a count
   * leaves nothing to report. Because the field is a plain number it cannot say "unknown",
   * so those providers guess, and they guess *differently* — two same-named `estimateTotal`
   * helpers existed with different formulas, one adding a phantom `+1` and one a whole
   * page. A consumer cannot tell a real total from a guess, which is why DLNA fabricates
   * `offset + count` of its own and Subsonic pages until it sees a short page.
   *
   * Kept as-is for the many producers that fill it; `totalKnown` is what makes the guess
   * visible so a consumer can stop treating it as fact.
   */
  totalitems: number;
  /**
   * Whether `totalitems` is a real count.
   *
   * Absent means unstated, which for existing producers reads as "no promise". Set it to
   * true only when the number came from upstream; set it to false when it is an estimate,
   * and a consumer should page until it sees a short page rather than trust the figure.
   */
  totalKnown?: boolean;
  start: number;
  service?: string;
  /** Optional grouped content for a home/feed-style browse surface. */
  sections?: ContentFolderSection[];
  /**
   * The container's own artwork, when the provider knows it.
   *
   * A folder browsed into directly used to describe itself with a name and nothing else, so
   * an album page had the album's tracks and no album cover — the rows each carried the
   * artwork their own container could not. Optional and provider-filled: nothing infers it,
   * because an inference here means a second lookup on every browse.
   */
  coverurl?: string;
  /** The container's byline (an album's artist), same contract as {@link ContentFolder.coverurl}. */
  artist?: string;
}

export interface ContentFolderSection {
  id: string;
  name: string;
  items: ContentFolderItem[];
}

export interface PlaylistEntry {
  id: string;
  name: string;
  tracks: number;
  audiopath: string;
  coverurl?: string;
}

export interface RadioStation {
  id: string;
  name: string;
  stream: string;
  coverurl?: string;
}

export interface RadioMenuEntry {
  cmd: string;
  name: string;
  icon: string;
  root: string;
  description?: string;
  editable?: boolean;
}

export type SpotifyAccountConfig = ConfigSpotifyAccountConfig;
export type StreamingServiceConfig = import('@/domain/config/types').StreamingServiceConfig;

export type ScanStatus = 0 | 1 | 2;

export interface ContentItemMetadata {
  title: string;
  artist: string;
  album: string;
  coverurl?: string;
  animatedCoverUrl?: string;
  duration?: number;
  station?: string;
}

export interface GlobalSearchResult {
  [key: string]: ContentFolderItem[];
}
