import { TuneInClient } from '@/adapters/content/providers/tunein/tuneinClient';
import {
  countPlayablePresets,
  expandPresetOutlines,
} from '@/adapters/content/providers/tunein/tuneinPresets';

/** Whether a TuneIn account exists, and what the browser will actually show for it. */
export type TuneInUsernameCheck = { found: false } | { found: true; presetCount: number };

/**
 * Whether a TuneIn username resolves, and how many playable presets it has.
 *
 * One operation because that is the one question the setup screen asks. The two halves of the
 * answer both need TuneIn's own quirks, which is why they belong here rather than in a route:
 *
 * - TuneIn answers 200 with an empty body for a name it does not know, so an absent head title
 *   is what makes a typo reportable at all (issue #362).
 * - Presets filed in folders or grouped into sections are stations too. Counting only the top
 *   level reported zero for accounts that had plenty.
 *
 * Throws what the client throws. Whether an upstream failure means "bad name" or "TuneIn is
 * down" is a judgement the route makes from the message, and it already did.
 */
export async function validateTuneInUsername(username: string): Promise<TuneInUsernameCheck> {
  const api = new TuneInClient();
  const { title, outlines } = await api.browsePresets(username);
  if (!title) {
    return { found: false };
  }
  const expanded = await expandPresetOutlines(api, outlines, username);
  return { found: true, presetCount: countPlayablePresets(expanded) };
}
