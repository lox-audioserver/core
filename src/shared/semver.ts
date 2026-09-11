/**
 * Version ordering, the one place that decides whether a version is "before" another.
 *
 * There were two comparators before this file, and they disagreed. The Admin UI carried a
 * correct one; the server carried one that split on `[.-]` and `parseInt`-ed every piece,
 * which reads `4.0.0-beta.21` as `[4,0,0,0,21]` and therefore sorts the finished `4.0.0`
 * *older* than its own beta. That is harmless while it only orders speaker builds, and
 * wrong the moment a comparison decides whether a bundle may be installed — this project
 * has lived on `4.0.0-beta.N` for its whole 4.0 cycle, so prereleases are the normal case
 * here, not the exception.
 *
 * Build metadata (`+testing-20260911`) is ignored, as SemVer requires: it distinguishes
 * two builds of the same version, so letting it change the ordering would make a nightly
 * image look newer than the release it was built from.
 */

export type ParsedVersion = {
  /** major, minor, patch — padded to three so `4.0` and `4.0.0` compare equal. */
  parts: number[];
  /** The `-beta.21` tail, or null for a release version. */
  prerelease: string | null;
};

/** Splits a version string, or returns null when it is not one — `dev`, a git hash, ''. */
export function parseVersion(input: string): ParsedVersion | null {
  const trimmed = input.trim().replace(/^v/i, '');
  if (!trimmed) {
    return null;
  }
  const [withoutBuild] = trimmed.split('+', 1);
  const [core, pre] = (withoutBuild ?? '').split('-', 2);
  const parts = (core ?? '')
    .split('.')
    .map((part) => Number.parseInt(part.replace(/\D+.*$/, ''), 10));
  if (parts.length === 0 || parts.some((part) => Number.isNaN(part))) {
    return null;
  }
  while (parts.length < 3) {
    parts.push(0);
  }
  return { parts, prerelease: pre ? pre.trim() : null };
}

/**
 * Orders two prerelease tails.
 *
 * Absent beats present — `4.0.0` is newer than `4.0.0-beta.30` — which is the SemVer rule
 * and also the trap worth naming: a `minCore` written as `4.0.0` locks out every beta
 * tester, so a minimum always names the beta the change actually landed in.
 *
 * Numeric identifiers compare numerically, so `beta.9` precedes `beta.21` instead of
 * sorting after it the way a string comparison would.
 */
export function comparePrerelease(a: string | null, b: string | null): -1 | 0 | 1 {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  const left = a.split('.');
  const right = b.split('.');
  const max = Math.max(left.length, right.length);

  for (let i = 0; i < max; i += 1) {
    const l = left[i];
    const r = right[i];
    // A shorter set of identifiers precedes a longer one with the same prefix.
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;

    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) {
      const ln = Number(l);
      const rn = Number(r);
      if (ln < rn) return -1;
      if (ln > rn) return 1;
      continue;
    }
    if (lNum && !rNum) return -1;
    if (!lNum && rNum) return 1;
    return l < r ? -1 : 1;
  }

  return 0;
}

/**
 * -1 when `a` is older than `b`, 1 when newer, 0 when equal *or when either side cannot
 * be parsed*.
 *
 * That last clause is deliberate and is what every caller here depends on: a server
 * running from a working copy reports `dev`, and an unorderable version must never be
 * treated as "behind" — it would gate a developer out of their own build.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return 0;
  }
  const length = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < length; i += 1) {
    const l = left.parts[i] ?? 0;
    const r = right.parts[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * Whether `running` is at least `minimum` — the question every compatibility gate asks.
 *
 * Open on both unknowns, and for different reasons. A missing `minimum` is a bundle built
 * before minimums existed: it made no claim, so refusing it would break every install that
 * updates before its next bundle is published. An unparseable `running` is a development
 * checkout, which must stay able to install anything.
 */
export function satisfiesMin(running: string | null | undefined, minimum: string | null | undefined): boolean {
  const min = (minimum ?? '').trim();
  const have = (running ?? '').trim();
  if (!min || !have) {
    return true;
  }
  if (!parseVersion(min) || !parseVersion(have)) {
    return true;
  }
  return compareVersions(have, min) >= 0;
}
