import type { SpotifyAccountConfig as ConfigSpotifyAccountConfig } from '@/domain/config/types';
import type { ContentItemKind } from '@/domain/media/contentKind';
import type { ProviderCapabilities } from '@/ports/ProviderCapabilities';

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
  /**
   * Loxone's `FileType` for this row, when the producer states one.
   *
   * Optional because it is a rendering decision for one consumer, not a property of the item:
   * a provider that says nothing here has its `type` derived from {@link kind} in the Loxone
   * adapter (see `deriveLoxoneFileType`). Stating it is what a producer does when it needs an
   * affordance `kind` cannot express — a follow toggle (`PlaylistFollowable`), an editable
   * playlist, a favourite, a search row — and those are the only reasons left to set it.
   */
  type?: number;
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
  /**
   * Whether the item can be followed at all — distinct from {@link followed}, which is whether it
   * currently *is*.
   *
   * A capability, not a state: it says the service will answer a follow query for this row, so a
   * client may offer the control. Only the real Spotify accounts set it, because
   * `SpotifyServiceManager.getFollowState` is the only implementation and it answers for exactly
   * album, artist, playlist and show — a bridged service addressed as `spotify` is skipped, and
   * every other provider has no follow at all. Drawing the toggle anywhere else gives the user a
   * button that reports "not followed" forever and does nothing when pressed.
   */
  followable?: boolean;
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

/**
 * One browsable top-level service the server can expose to an external content
 * client (the DLNA MediaServer's ContentDirectory, the Subsonic API, …).
 *
 * `key` is the stable identity used in the client-facing object/entity ids: the
 * literals `library`/`radio` for the built-ins, and the service-native name for a
 * streaming account (`applemusic`, or `applemusic:p0gngd` when a service has more
 * than one). One provider type can have several accounts, each of which is its own
 * service here. Deliberately NOT the Loxone bridge id: that word describes a
 * disguise these clients are not party to.
 *
 * `browse` and `relatedArtists` are already bound to the content layer: a consumer holds a
 * service and asks it, rather than being handed a function and having to supply the backend.
 * That is what lets this type live in a port at all.
 *
 * `id3Probe` is the folder whose children carry the collection entry points
 * ("Albums"/"Artists"/"Playlists"). For a streaming bridge that is its root; for
 * the local library the root lists storages, so it points one level deeper.
 */
export type BrowsableService = {
  key: string;
  /** Provider type — used for allowlist matching and default titles. */
  provider: string;
  title: string;
  /** Native folder id for this service's own top level. */
  rootFolderId: string;
  /** Folder to probe for collection entry points, when different from the root. */
  id3Probe: string;
  /** `globalSearch` source for this service, or null when it cannot search. */
  searchSource: string | null;
  /**
   * What this service can actually do — which item kinds its search returns, and whether
   * its catalogue is larger than the user's collection.
   *
   * Distinct from `searchSource`, which only names the search *endpoint*: two services can
   * both be searchable and disagree about albums. A consumer should offer the kinds listed
   * here rather than assume every service serves the same set, which is what
   * `globalsearch/describe` used to assert for all of them.
   */
  capabilities: ProviderCapabilities;
  browse: (folderId: string, offset: number, limit: number) => Promise<ContentFolder | null>;
  /**
   * The artists this service itself puts beside one of its own, when it has the notion.
   *
   * Absent for the local library and the radio tile, and that absence is the point: "who else
   * would I like" is editorial data a catalogue owner has and a folder of files does not.
   */
  relatedArtists?: (folderId: string, limit: number) => Promise<ContentFolderItem[]>;
};

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
