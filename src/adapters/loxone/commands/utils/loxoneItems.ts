import { resolveItemKind } from '@/adapters/content/contentItemKind';
import { FileType } from '@/domain/zones/enums';
import type { ContentItemKind } from '@/domain/media/contentKind';
import type { ContentFolderItem } from '@/ports/ContentTypes';

/**
 * What a row of each kind renders as, for a producer that did not say.
 *
 * A `Record` rather than a switch so adding a `ContentItemKind` fails to compile until this
 * table answers for it — the alternative is a new kind quietly arriving on the wire as
 * `Unknown`, which the app draws as nothing at all.
 *
 * Containers all map to `PlaylistBrowsable`: it is the one container value that says only "the
 * app may open this". The richer container types encode an affordance `kind` does not carry
 * (a follow toggle, an editable playlist), so they stay the producer's business — see
 * {@link ContentFolderItem.type}.
 */
const FILE_TYPE_BY_KIND: Record<ContentItemKind, FileType> = {
  track: FileType.File,
  radio: FileType.File,
  episode: FileType.File,
  album: FileType.PlaylistBrowsable,
  artist: FileType.PlaylistBrowsable,
  playlist: FileType.PlaylistBrowsable,
  show: FileType.PlaylistBrowsable,
  category: FileType.PlaylistBrowsable,
  folder: FileType.Folder,
};

/**
 * The Loxone `FileType` for an item, from what it says about itself.
 *
 * An explicit `type` always wins: it is how a producer asks for an affordance this table cannot
 * infer, and half the catalogue still states one.
 */
export function deriveLoxoneFileType(item: ContentFolderItem): FileType {
  return item.type ?? FILE_TYPE_BY_KIND[resolveItemKind(item)];
}

/**
 * Keeps the Loxone wire exactly as the clients expect it.
 *
 * The content layer carries a neutral `kind` ('album', 'artist', …) so consumers that are not
 * Loxone — DLNA, Subsonic, our own player — can tell what an item is. The Loxone apps decide how
 * to render a row from `type` and `tag`: `tag` is passed through untouched, `type` is filled in
 * here when the producer left it out, and `kind` is ours alone and dropped rather than shipped
 * as a field the app does not know.
 */
export function stripNeutralItemFields(items: ContentFolderItem[]): ContentFolderItem[] {
  return items.map((item) => {
    // Resolved before `kind` is dropped, since that is what the resolution reads first.
    const type = deriveLoxoneFileType(item);
    const { kind: _kind, ...wire } = item;
    return { ...wire, type };
  });
}

/** {@link stripNeutralItemFields} for a folder payload. */
export function forLoxoneFolder<T extends { items?: ContentFolderItem[] }>(folder: T): T {
  return Array.isArray(folder.items)
    ? { ...folder, items: stripNeutralItemFields(folder.items) }
    : folder;
}

/** {@link stripNeutralItemFields} for a global-search result, keyed by category. */
export function forLoxoneSearchResult<T extends Record<string, unknown>>(result: T): T {
  const out: Record<string, unknown> = { ...result };
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value)) {
      out[key] = stripNeutralItemFields(value as ContentFolderItem[]);
    }
  }
  return out as T;
}
