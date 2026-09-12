/**
 * The build-time half of the bundle compatibility check.
 *
 * `fetch:admin` and `fetch:player` pull whatever release the bundle repos call latest, into
 * a core checked out at whatever version it happens to be. Nothing compared the two, so a
 * console built against endpoints this core does not have could be baked straight into a
 * release image — the one place a mismatch is fully preventable, and the one where it is
 * hardest to notice afterwards.
 *
 * Deliberately a hard failure rather than a warning. The asymmetry is what makes that safe:
 * it can only fire when the *bundle* is ahead of the core being built, never when the core
 * is ahead of the bundle, so an ordinary release — core moves first, bundles follow — never
 * sees it. `SONN_SKIP_BUNDLE_COMPAT=1` is there for the deliberate one-off.
 *
 * Dev is exempt outright — see `isDevBuild`. It is the one branch where the version number is
 * routinely behind the code, so the comparison is measuring the wrong thing there and only
 * there.
 *
 * A plain `.mjs` duplicate of `src/shared/semver.ts` on purpose: these scripts run before
 * `tsc` has produced `dist/`, so they cannot import the compiled module they mirror. The
 * behaviour is pinned on the TypeScript side by `tests/bundleCompat.test.ts`.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseVersion(input) {
  const trimmed = String(input ?? '').trim().replace(/^v/i, '');
  if (!trimmed) return null;
  const [withoutBuild] = trimmed.split('+', 1);
  const [core, pre] = (withoutBuild ?? '').split('-', 2);
  const parts = (core ?? '').split('.').map((part) => Number.parseInt(part.replace(/\D+.*$/, ''), 10));
  if (parts.length === 0 || parts.some((part) => Number.isNaN(part))) return null;
  while (parts.length < 3) parts.push(0);
  return { parts, prerelease: pre ? pre.trim() : null };
}

function comparePrerelease(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) {
      if (Number(l) < Number(r)) return -1;
      if (Number(l) > Number(r)) return 1;
      continue;
    }
    if (lNum && !rNum) return -1;
    if (!lNum && rNum) return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
    const l = left.parts[i] ?? 0;
    const r = right.parts[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Open on both unknowns: a bundle that states nothing, and a core that cannot be read. */
export function satisfiesMin(running, minimum) {
  const min = String(minimum ?? '').trim();
  const have = String(running ?? '').trim();
  if (!min || !have) return true;
  if (!parseVersion(min) || !parseVersion(have)) return true;
  return compareVersions(have, min) >= 0;
}

/**
 * Whether this build is explicitly a development one, in which case minimums do not apply.
 *
 * On `dev` the version number is the only thing behind: the branch carries the endpoints of
 * the next release while still calling itself the last one, so a bundle built against those
 * endpoints fails a check that is, on this branch alone, measuring the wrong thing. Dev takes
 * the newest of everything — nobody runs it except to try a fix.
 *
 * Declared rather than assumed. `BUILD_CHANNEL` is what CI sets, and it is read first because
 * a CI checkout is on a detached HEAD and has no branch to read. Falling back to the branch is
 * for the developer running `npm run build` in their own working copy. A checkout that is
 * neither is not dev, and stays gated.
 */
export async function isDevBuild(cwd) {
  const declared = (process.env.BUILD_CHANNEL ?? '').trim().toLowerCase();
  if (declared) return declared === 'dev';
  const stamp = (process.env.BUILD_TIMESTAMP ?? '').trim().toLowerCase();
  if (stamp.startsWith('dev-')) return true;
  if (stamp.startsWith('testing-')) return false;
  try {
    const head = await fs.readFile(join(cwd, '.git', 'HEAD'), 'utf8');
    return /^ref:\s*refs\/heads\/dev\s*$/i.test(head.trim());
  } catch {
    return false;
  }
}

export async function readCoreVersion(cwd) {
  try {
    const pkg = JSON.parse(await fs.readFile(join(cwd, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Throws when the bundle now sitting in `dir` needs a newer core than this one.
 *
 * Reads the manifest the bundle build emits; a directory without one is a release from
 * before manifests existed and passes, which is what keeps this from breaking every
 * existing install the day it lands.
 */
export async function assertBundleFitsCore(dir, coreVersion, label) {
  if ((process.env.SONN_SKIP_BUNDLE_COMPAT ?? '').trim() === '1') return;
  if (await isDevBuild(process.cwd())) {
    console.log(`[bundle-compat] dev build, taking ${label} as published`);
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(join(dir, 'version.json'), 'utf8'));
  } catch {
    return;
  }
  const minCore = typeof manifest?.minCore === 'string' ? manifest.minCore.trim() : '';
  if (!minCore || satisfiesMin(coreVersion, minCore)) return;

  const version = typeof manifest?.version === 'string' ? manifest.version : 'unknown';
  throw new Error(
    `${label} ${version} requires server core ${minCore}, but this checkout is ${coreVersion}.\n` +
      `       Pin an older bundle (e.g. ADMINUI_RELEASE / PLAYER_RELEASE=vX.Y.Z), bump the core,\n` +
      `       or set SONN_SKIP_BUNDLE_COMPAT=1 if you know this pairing is fine.`,
  );
}

/**
 * The compiled resolver, or null when there is nothing compiled yet.
 *
 * `npm run build` runs `tsc` before it fetches the bundles, so during a real build `dist/` is
 * there and the decision about which release fits is the *same code the server runs* — which
 * is the point: an image must not bake in a console the running server would have refused.
 *
 * Running `npm run fetch:admin` on its own in a fresh clone is the case where it is missing.
 * That degrades to the static `releases/latest` URL, which is exactly what this did before
 * any of it existed, and `assertBundleFitsCore` still refuses a pairing that cannot work.
 */
async function loadResolver(cwd) {
  try {
    const url = (rel) => pathToFileURL(join(cwd, 'dist', rel)).href;
    const [release, upstream] = await Promise.all([
      import(url('shared/bundleRelease.js')),
      import(url('adapters/http/adminApi/misc/upstreamJson.js')),
    ]);
    if (typeof release.resolveBundleRelease !== 'function') return null;
    return { release, fetchJson: upstream.fetchUpstreamJson };
  } catch {
    return null;
  }
}

/**
 * Where to download a bundle from, preferring the newest release this core can actually serve.
 *
 * The reason this is not simply `releases/latest`: a bundle repo moves on, and a core being
 * built from an older branch would otherwise either bake in a console it cannot serve or fail
 * outright. Reaching one release back is the same answer the server gives an install on an
 * older core, and it keeps a build of an older core producing a working image.
 *
 * Honours the existing pins first — `*_DIST_URL` and `*_RELEASE` name a version, and naming
 * one is not asking for our opinion.
 */
export async function resolveBundleUrl({ cwd, repo, assetName, releaseEnv, distUrlEnv, label }) {
  const urlOverride = (process.env[distUrlEnv] ?? '').trim();
  if (urlOverride) return { distUrl: urlOverride, picked: 'pinned' };

  const explicit = (process.env[releaseEnv] ?? '').trim();
  if (explicit && explicit !== 'latest') {
    return {
      distUrl: `https://github.com/${repo}/releases/download/${encodeURIComponent(explicit)}/${assetName}`,
      picked: 'pinned',
    };
  }

  const latest = `https://github.com/${repo}/releases/latest/download/${assetName}`;
  const loaded = await loadResolver(cwd);
  if (!loaded) return { distUrl: latest, picked: 'latest' };

  const coreVersion = await readCoreVersion(cwd);
  try {
    const resolved = await loaded.release.resolveBundleRelease({
      repo,
      assetName,
      coreVersion,
      channel: loaded.release.channelFor(coreVersion ?? '', process.env.SERVER_RELEASE_CHANNEL),
      newestWins: await isDevBuild(cwd),
      fetchJson: loaded.fetchJson,
      log: (message, detail) => console.log(`[bundle-compat] ${label}: ${message}`, detail ?? ''),
    });
    if (resolved.picked === 'compatible' && resolved.release !== 'latest') {
      console.log(`[bundle-compat] ${label}: ${resolved.release} is the newest that fits core ${coreVersion}`);
    }
    return { distUrl: resolved.distUrl, picked: resolved.picked };
  } catch (err) {
    console.warn(`[bundle-compat] ${label}: could not resolve a release (${err?.message ?? err}), using latest`);
    return { distUrl: latest, picked: 'latest' };
  }
}
