/**
 * Which release of a web bundle a given core should get.
 *
 * Asked from two places that must not disagree. The server asks it when somebody presses
 * update, and the build asks it when it assembles an image — and an image that bakes in a
 * console the running server would have refused is the failure this whole mechanism exists
 * to prevent. So the decision lives here, with the network injected, rather than twice.
 *
 * Two rules, in order.
 *
 * **The channel, taken from the core.** A bundle is a satellite of the server serving it, so
 * a beta core asks for beta bundles. Stables stay eligible behind them, and that fallback is
 * not optional: these repos may publish no prereleases at all, and a beta install must then
 * receive the stable bundle rather than nothing. A stable core never takes a prerelease.
 *
 * **Then compatibility.** Within the channel, the newest release whose `minCore` this core
 * satisfies. That is what lets an install on an older core keep working: it receives the last
 * bundle built for it instead of a dead button, or — at build time — instead of a failed
 * build. Releases that predate manifests state nothing and are therefore compatible with
 * everything, which is what makes this safe to switch on against a repo full of them.
 */
import { satisfiesMin } from '@/shared/semver';
import { manifestFrom, type BundleManifest } from '@/shared/bundleManifest';

export type ReleaseChannel = 'stable' | 'beta';

/** One release of a bundle repo, as far as choosing between them needs to know. */
export type BundleRelease = { tag: string; prerelease: boolean };

export type ResolvedBundleRelease = {
  /** The tag to install, or `latest` when we are falling back to the static URL. */
  release: string;
  distUrl: string;
  /** What made the choice, for the log line that explains a surprising pick. */
  picked: 'compatible' | 'newest' | 'fallback-latest';
};

export type BundleReleaseQuery = {
  repo: string;
  assetName: string;
  /** The core the bundle has to be able to serve. */
  coreVersion: string;
  channel: ReleaseChannel;
  /**
   * Skip the compatibility walk and take the newest of the channel.
   *
   * Set on dev builds, where the version number is behind the code by design — walking for a
   * compatible release there would step past bundles the server can serve perfectly well, on
   * the strength of a version string that is stale on purpose.
   */
  newestWins?: boolean;
  fetchJson: (url: string) => Promise<unknown>;
  log?: (message: string, detail?: Record<string, unknown>) => void;
};

/**
 * How many candidates to inspect before giving up.
 *
 * Each costs one small HTTPS request, and a bundle more than a handful of releases ahead of
 * this core is a mismatch worth reporting rather than silently reaching back past.
 */
export const BUNDLE_LOOKBACK = 6;

export function bundleAssetUrl(repo: string, assetName: string, tag: string): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${assetName}`;
}

/** The manifest published beside a release's tarball, so which bundle fits can be decided
 *  before downloading megabytes of it. */
export function bundleManifestUrl(repo: string, tag: string): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/version.json`;
}

export function bundleLatestUrl(repo: string, assetName: string): string {
  return `https://github.com/${repo}/releases/latest/download/${assetName}`;
}

/**
 * The channel a core version belongs to: a SemVer prerelease suffix means beta.
 *
 * Shared so the server and the build agree about it. `SERVER_RELEASE_CHANNEL` overrides, and
 * governs all three artefacts rather than just the server it is named after.
 */
export function channelFor(coreVersion: string, override?: string | null): ReleaseChannel {
  const forced = (override ?? '').trim().toLowerCase();
  if (forced === 'beta' || forced === 'prerelease') return 'beta';
  if (forced === 'stable' || forced === 'latest') return 'stable';
  return coreVersion.includes('-') ? 'beta' : 'stable';
}

/**
 * Recent releases of a bundle repo, newest first.
 *
 * Deliberately not `releases/latest`: that endpoint never resolves to a prerelease, which is
 * the reason a beta bundle could not reach a beta install before any of this. Drafts and
 * releases without the tarball are dropped here, so the caller never resolves to a 404.
 */
export async function fetchBundleReleases(
  repo: string,
  assetName: string,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<BundleRelease[]> {
  const data = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=30`);
  if (!Array.isArray(data)) {
    return [];
  }
  const out: BundleRelease[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const rel = entry as {
      tag_name?: string;
      prerelease?: boolean;
      draft?: boolean;
      assets?: Array<{ name?: string }>;
    };
    if (rel.draft) continue;
    if (!Array.isArray(rel.assets) || !rel.assets.some((a) => a?.name === assetName)) continue;
    const tag = typeof rel.tag_name === 'string' ? rel.tag_name.trim() : '';
    if (tag) {
      out.push({ tag, prerelease: rel.prerelease === true });
    }
  }
  return out;
}

/** Candidates in the order this channel prefers them. */
export function orderCandidates(
  releases: BundleRelease[],
  channel: ReleaseChannel,
): BundleRelease[] {
  return channel === 'beta'
    ? [...releases.filter((r) => r.prerelease), ...releases.filter((r) => !r.prerelease)]
    : releases.filter((r) => !r.prerelease);
}

export async function resolveBundleRelease(
  query: BundleReleaseQuery,
): Promise<ResolvedBundleRelease> {
  const { repo, assetName, coreVersion, channel, fetchJson } = query;
  const log = query.log ?? (() => {});
  const asset = (tag: string): string => bundleAssetUrl(repo, assetName, tag);

  let releases: BundleRelease[] = [];
  try {
    releases = await fetchBundleReleases(repo, assetName, fetchJson);
  } catch (err) {
    // The listing is an optimisation, not a requirement: without it the static URL still
    // installs the newest stable, and the caller's own check still guards the result.
    log('release listing unavailable, falling back to latest', {
      repo,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const candidates = orderCandidates(releases, channel);
  const first = candidates[0];

  if (query.newestWins && first) {
    log('taking the newest release, minimums are waived', { repo, tag: first.tag });
    return { release: first.tag, distUrl: asset(first.tag), picked: 'newest' };
  }

  for (const candidate of candidates.slice(0, BUNDLE_LOOKBACK)) {
    let manifest: BundleManifest;
    try {
      manifest = manifestFrom(await fetchJson(bundleManifestUrl(repo, candidate.tag)));
    } catch {
      // No manifest asset: a release from before this existed, which claims nothing and is
      // therefore installable. Taking it here also ends the walk, which is right — the
      // releases below it cannot be newer.
      return { release: candidate.tag, distUrl: asset(candidate.tag), picked: 'newest' };
    }
    if (satisfiesMin(coreVersion, manifest.minCore)) {
      return { release: candidate.tag, distUrl: asset(candidate.tag), picked: 'compatible' };
    }
    log('release skipped, needs a newer core', {
      repo,
      tag: candidate.tag,
      minCore: manifest.minCore,
      coreVersion,
    });
  }

  // Nothing in the window fit, or the listing never arrived. The static URL is the honest
  // last answer: it is what happened before any of this, and both callers check what they
  // end up with — the server refuses the swap, the build refuses the image.
  return {
    release: 'latest',
    distUrl: bundleLatestUrl(repo, assetName),
    picked: 'fallback-latest',
  };
}
