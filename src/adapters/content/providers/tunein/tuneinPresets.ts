import type { TuneInClient } from '@/adapters/content/providers/tunein/tuneinClient';

/**
 * A raw Browse.ashx outline — only the fields the preset walk looks at.
 */
type PresetOutline = {
  type?: string;
  item?: string;
  key?: string;
  guide_id?: string;
  children?: unknown[];
  text?: string;
  subtext?: string;
  image?: string;
  bitrate?: string;
  formats?: string;
  /** Where the account itself put this preset. Their order is the one worth showing. */
  preset_number?: string;
};

/**
 * One preset, as much of it as a screen showing someone their account needs.
 *
 * Everything here rides along on the listing TuneIn already answered with, so naming a
 * preset costs nothing extra — resolving its stream would cost a request each, and a list
 * you are only looking at does not need one.
 */
export interface TuneInPreset {
  id: string;
  name: string;
  description?: string;
  logo?: string;
  bitrate?: number;
  formats?: string;
}

/**
 * TuneIn returns an account's presets in one of three layouts, depending on how the
 * account organises its favourites:
 *
 *   1. a flat list of `type: "audio"` outlines;
 *   2. sections ("Stations (27)", "Shows (4)") that carry their entries in `children`;
 *   3. folders — `type: "link"` outlines pointing at another Browse (`guide_id` `fNNNN`).
 *
 * Only the first arrived as stations before, so an account that used folders or sections
 * looked exactly like a username TuneIn had never heard of (see issue #362). These walk
 * the other two down to the audio outlines they hide.
 */

/** Folders to follow per listing — a bound on how much one browse can fan out. */
const MAX_FOLDER_REQUESTS = 12;
/** Folders nest at most one level in practice; stop there rather than trust the data. */
const MAX_FOLDER_DEPTH = 2;

function isFolder(outline: PresetOutline): boolean {
  // Shows are links too (`item: "show"`, `guide_id` `pNNNN`), but lead to episodes
  // rather than to presets — only the `f`-prefixed guide ids are favourite folders.
  return outline.type === 'link' && outline.item !== 'show' && /^f\d/.test(outline.guide_id ?? '');
}

/**
 * Flattens a preset listing to the audio outlines it contains, following favourite
 * folders (bounded by {@link MAX_FOLDER_REQUESTS} / {@link MAX_FOLDER_DEPTH}).
 * A folder that fails to load is reported and skipped — one unreachable folder must
 * not cost the account its other presets.
 */
export async function expandPresetOutlines(
  api: TuneInClient,
  outlines: unknown[],
  username: string,
  onFolderError?: (id: string, message: string) => void,
): Promise<unknown[]> {
  const flat: unknown[] = [];
  let budget = MAX_FOLDER_REQUESTS;

  const walk = async (entries: unknown[], depth: number): Promise<void> => {
    const folderIds: string[] = [];

    for (const raw of entries) {
      const outline = (raw ?? {}) as PresetOutline;
      if (Array.isArray(outline.children) && outline.children.length) {
        await walk(outline.children, depth);
        continue;
      }
      if (isFolder(outline)) {
        // A folder is never a station itself, so it is dropped either way.
        if (depth < MAX_FOLDER_DEPTH && budget > 0 && outline.guide_id) {
          budget -= 1;
          folderIds.push(outline.guide_id);
        }
        continue;
      }
      flat.push(raw);
    }

    if (!folderIds.length) {
      return;
    }

    const contents = await Promise.all(
      folderIds.map(async (id) => {
        try {
          return (await api.browseFolder(id, username)).outlines;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          onFolderError?.(id, message);
          return [];
        }
      }),
    );

    for (const entries of contents) {
      await walk(entries, depth + 1);
    }
  };

  await walk(outlines, 0);
  return flat;
}

/**
 * Presets that can actually play here, in the order the account arranged them.
 *
 * TuneIn keeps geo-blocked and delisted stations in a listing but marks them `unavailable`
 * and points them at a spoken "not supported" clip, so listing those would promise presets
 * that only produce that clip.
 *
 * Sorted by TuneIn's own preset number where there is one: an account's favourites have an
 * order its owner chose, and folders are walked in whatever sequence they came back in.
 */
export function listPlayablePresets(outlines: unknown[]): TuneInPreset[] {
  return outlines
    .map((raw) => (raw ?? {}) as PresetOutline)
    .filter((outline) => outline.type === 'audio' && outline.key !== 'unavailable')
    .map((outline, index) => ({ outline, order: presetOrder(outline, index) }))
    .sort((a, b) => a.order - b.order)
    .map(({ outline }) => toPreset(outline))
    .filter((preset): preset is TuneInPreset => preset !== null);
}

/** A preset's place in the account, or its place in the listing when it has no number. */
function presetOrder(outline: PresetOutline, index: number): number {
  const declared = Number.parseInt(outline.preset_number ?? '', 10);
  return Number.isFinite(declared) ? declared : Number.MAX_SAFE_INTEGER - 1000 + index;
}

function toPreset(outline: PresetOutline): TuneInPreset | null {
  const id = outline.guide_id?.trim();
  const name = outline.text?.trim();
  if (!id || !name) {
    return null;
  }
  const bitrate = Number.parseInt(outline.bitrate ?? '', 10);
  return {
    id,
    name,
    ...(outline.subtext?.trim() ? { description: outline.subtext.trim() } : {}),
    ...(/^https?:\/\//i.test(outline.image ?? '') ? { logo: outline.image as string } : {}),
    ...(Number.isFinite(bitrate) && bitrate > 0 ? { bitrate } : {}),
    ...(outline.formats?.trim() ? { formats: outline.formats.trim() } : {}),
  };
}
