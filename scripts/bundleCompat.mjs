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
 * sees it. `SONN_SKIP_BUNDLE_COMPAT=1` is there for the deliberate exception.
 *
 * A plain `.mjs` duplicate of `src/shared/semver.ts` on purpose: these scripts run before
 * `tsc` has produced `dist/`, so they cannot import the compiled module they mirror. The
 * behaviour is pinned on the TypeScript side by `tests/bundleCompat.test.ts`.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

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
