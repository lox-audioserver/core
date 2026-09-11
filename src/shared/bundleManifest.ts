/**
 * What a web bundle says about itself.
 *
 * The Admin UI and the Player are separate repositories on their own release cadence, and
 * an install mixes and matches: the server core updates on one button, each bundle on
 * another, in whatever order somebody presses them. Nothing stopped a bundle that needs an
 * endpoint this core does not have from being installed onto it, and the result is not an
 * error anybody sees — it is a console that renders and then quietly 404s.
 *
 * So each bundle ships a `version.json` beside its `index.html`:
 *
 *     { "version": "6.1.0", "minCore": "4.0.0-beta.22" }
 *
 * `minCore` is the oldest core that can serve this bundle. It is written by hand in the
 * bundle's own `package.json` (`sonn.minCore`) and emitted into the build, so it travels
 * with the artefact — the release tarball, a local build, and the copy the server fetches
 * all carry it without any of them knowing about it.
 *
 * Both fields are optional on purpose. Every bundle released before this existed has
 * neither, and those must keep installing: see `satisfiesMin`, which is open on unknowns.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { satisfiesMin } from '@/shared/semver';

/** The sub-directory of `publicDir` a bundle is served from. */
export type WebBundleName = 'admin' | 'player';

export type BundleManifest = {
  version: string | null;
  /** Oldest server core that can serve this bundle, or null when it does not say. */
  minCore: string | null;
};

/** A bundle as the status endpoint reports it: what is installed, and whether it fits. */
export type BundleStatus = BundleManifest & {
  installed: string | null;
  /** False only when the bundle states a minimum this core is genuinely below. */
  satisfied: boolean;
};

const EMPTY: BundleManifest = { version: null, minCore: null };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Reads a manifest that has already been parsed — an HTTP client handing back JSON, say. */
export function manifestFrom(value: unknown): BundleManifest {
  if (!value || typeof value !== 'object') {
    return EMPTY;
  }
  const parsed = value as { version?: unknown; minCore?: unknown };
  return { version: text(parsed.version), minCore: text(parsed.minCore) };
}

/** Parses manifest JSON. Anything unexpected reads as "said nothing", never as a throw:
 *  this runs on the path of a status request and inside an update's preflight, and a
 *  malformed file must degrade to the pre-manifest behaviour rather than break either. */
export function parseBundleManifest(raw: string): BundleManifest {
  try {
    return manifestFrom(JSON.parse(raw));
  } catch {
    return EMPTY;
  }
}

/** Reads `version.json` from a bundle directory. A bundle that was never fetched, or one
 *  built before the manifest existed, reads as empty rather than missing. */
export function readBundleManifest(bundleDir: string): BundleManifest {
  try {
    return parseBundleManifest(readFileSync(join(bundleDir, 'version.json'), 'utf8'));
  } catch {
    return EMPTY;
  }
}

export function bundleDir(publicDir: string, name: WebBundleName): string {
  return join(publicDir, name);
}

/** Why a bundle may not be installed here. */
export type BundleRejection = { requiredCore: string; runningCore: string };

/**
 * The decision an update's preflight makes, with no file system or network in it.
 *
 * Separate from the update that calls it so the rule can be tested directly: the part worth
 * being sure about is *which* pairings are refused, not that a tarball can be moved.
 * Returns null for "install it", which is the answer for every bundle that states no
 * minimum and every core too unusual to order.
 */
export function rejectIfCoreTooOld(
  runningCore: string,
  manifest: BundleManifest,
): BundleRejection | null {
  if (satisfiesMin(runningCore, manifest.minCore) || !manifest.minCore) {
    return null;
  }
  return { requiredCore: manifest.minCore, runningCore };
}

/** The installed bundle, judged against the core that is running it. */
export function describeBundle(
  publicDir: string,
  name: WebBundleName,
  runningCore: string,
): BundleStatus {
  const manifest = readBundleManifest(bundleDir(publicDir, name));
  return {
    ...manifest,
    installed: manifest.version,
    satisfied: satisfiesMin(runningCore, manifest.minCore),
  };
}

/**
 * The minimum bundle versions this core asks for, from its own `package.json`.
 *
 * The mirror image of `minCore`, and it cannot be a gate: by the time a core notices the
 * console is too old, that console is already the one rendering the page. It exists so the
 * UI can say so out loud and point at its own update button. Which means the first bundle
 * able to show that message is the one that ships support for reading this — for an install
 * upgrading from before, the warning starts working one UI update later.
 */
export type CoreBundleRequirements = { adminUi: string | null; player: string | null };

export function readCoreBundleRequirements(packageJsonPath: string): CoreBundleRequirements {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      sonn?: { minAdminUi?: unknown; minPlayer?: unknown };
    };
    return {
      adminUi: text(parsed.sonn?.minAdminUi),
      player: text(parsed.sonn?.minPlayer),
    };
  } catch {
    return { adminUi: null, player: null };
  }
}
