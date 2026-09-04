/**
 * What a browsable item actually is, independent of any protocol.
 *
 * The neutral vocabulary every consumer can rely on: DLNA maps it onto UPnP
 * classes, the public API onto `ApiItemKind`, the Loxone adapter keeps
 * projecting its own `type` number alongside.
 *
 * It lives in the domain because the browse ids in `browseRef.ts` carry a kind
 * with them, and an id scheme cannot depend on a port to say what it holds.
 * `ContentFolderItem.kind` in `@/ports/ContentTypes` is the same type.
 */
export type ContentItemKind =
  | 'track'
  | 'album'
  | 'artist'
  | 'playlist'
  /** A live stream (internet radio); playable, but not a fixed-length track. */
  | 'radio'
  /** A podcast/show container and its episodes. */
  | 'show'
  | 'episode'
  /** A browse-only grouping (genres, moods, "browse" roots). */
  | 'category'
  /** Anything else browsable: storage folders, service roots, unknown containers. */
  | 'folder';

/**
 * What {@link resolveItemKind} needs to classify a row.
 *
 * A structural subset rather than `ContentFolderItem`, which lives in `@/ports`: the domain is
 * the innermost layer and may not reach a port for a type. Four fields is also the honest
 * contract — the resolution reads nothing else, and every producer's item satisfies it.
 */
export type ClassifiableItem = {
  kind?: ContentItemKind;
  /** Legacy Loxone-facing hint string ('track', 'album', 'nas', …). */
  tag?: string;
  /** Loxone `FileType`, when the producer states one. */
  type?: number;
  audiopath?: string;
};

/**
 * Loxone FileType for a directly playable file.
 *
 * Still read here, and load-bearing: the local library tags a row by where it lives ('nas',
 * 'sd') for both its folders and its tracks, and both carry an audiopath. `type` is the only
 * thing that tells those two apart, so a storage-tagged row that drops it becomes a folder.
 * A provider migrating off `type` has to state `kind` instead — the number cannot simply go.
 */
const FILE_TYPE_TRACK = 2;

const TAG_TO_KIND: Record<string, ContentItemKind> = {
  track: 'track',
  album: 'album',
  artist: 'artist',
  playlist: 'playlist',
  radio: 'radio',
  station: 'radio',
  show: 'show',
  episode: 'episode',
  category: 'category',
  // Storage locations, not kinds.
  nas: 'folder',
  sd: 'folder',
  folder: 'folder',
};

export function resolveItemKind(item: ClassifiableItem): ContentItemKind {
  if (item.kind) {
    return item.kind;
  }
  const tag = item.tag?.trim().toLowerCase();
  const mapped = tag ? TAG_TO_KIND[tag] : undefined;
  // A playable file is a track when its tag says nothing about what it is: the local
  // library tags tracks by storage ('sd'/'nas'), so that must not decide the kind.
  //
  // It must not override a tag that *does* name a kind, though. Radio stations are
  // playable files tagged 'radio', and letting the file check win made every station
  // indistinguishable from a track at every consumer — which also left `kind: 'radio'`
  // unreachable in practice, since no provider sets it explicitly.
  if (item.type === FILE_TYPE_TRACK && item.audiopath && (!mapped || mapped === 'folder')) {
    return 'track';
  }
  if (mapped) {
    return mapped;
  }
  return 'folder';
}

/** Whether a kind is a container others can browse into. */
export function isContainerKind(kind: ContentItemKind): boolean {
  return kind !== 'track' && kind !== 'radio' && kind !== 'episode';
}
