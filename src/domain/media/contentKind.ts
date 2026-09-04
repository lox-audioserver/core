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
