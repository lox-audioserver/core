import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { compareVersions, satisfiesMin } from '../src/shared/semver';
import {
  describeBundle,
  parseBundleManifest,
  readBundleManifest,
  readCoreBundleRequirements,
  rejectIfCoreTooOld,
} from '../src/shared/bundleManifest';
import { buildMiscRoutes } from '../src/adapters/http/adminApi/misc/miscHandlers';
import { isDevBuild } from '../src/shared/serverVersion';

/*
 * The Admin UI and the Player are separate repositories, updated by separate buttons, in
 * whatever order somebody presses them. Nothing stopped a bundle that needs an endpoint
 * this core does not have from being installed onto it, and the result is not an error
 * anybody sees — a console that renders and then quietly 404s.
 *
 * What is pinned here is the rule, not the plumbing: which pairings are refused. The
 * project has spent its whole 4.0 cycle on `4.0.0-beta.N`, so prereleases are the ordinary
 * case, and the comparator the server used before this got them wrong in both directions.
 */

function bundleAt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sonn-bundle-'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

test('version ordering handles the prerelease cases a beta cycle actually hits', () => {
  // Numerically, so beta.9 precedes beta.21 rather than sorting after it as a string.
  assert.equal(compareVersions('4.0.0-beta.9', '4.0.0-beta.21'), -1);
  assert.equal(compareVersions('4.0.0-beta.22', '4.0.0-beta.21'), 1);
  // A finished release is newer than its own beta. The old comparator had this backwards,
  // which is harmless when ordering speakers and wrong when it decides an install.
  assert.equal(compareVersions('4.0.0', '4.0.0-beta.30'), 1);
  // Build metadata distinguishes two builds of one version; it must not reorder them.
  assert.equal(compareVersions('4.0.0-beta.21+testing-20260911', '4.0.0-beta.21'), 0);
  assert.equal(compareVersions('4.0', '4.0.0'), 0);
});

test('a minimum is satisfied by the release that follows the beta it names', () => {
  assert.equal(satisfiesMin('4.0.0-beta.22', '4.0.0-beta.22'), true);
  assert.equal(satisfiesMin('4.0.0', '4.0.0-beta.22'), true, 'stable clears a beta minimum');
  assert.equal(satisfiesMin('4.1.0-beta.1', '4.0.0-beta.22'), true);
  assert.equal(satisfiesMin('4.0.0-beta.21', '4.0.0-beta.22'), false);
  assert.equal(satisfiesMin('3.1.0', '4.0.0-beta.22'), false);

  // The trap worth a test of its own: a minimum written as the stable a beta cycle is
  // heading for locks out every install in that cycle. Minimums name the beta they landed
  // in, and this is what goes wrong when they do not.
  assert.equal(satisfiesMin('4.0.0-beta.30', '4.0.0'), false);
});

test('unknowns are open, so a dev checkout and an old bundle both still install', () => {
  // `readPackageVersion` reports `dev` when it cannot read package.json at all.
  assert.equal(satisfiesMin('dev', '4.0.0-beta.22'), true, 'a working copy is not gated');
  assert.equal(satisfiesMin('4.0.0-beta.21', null), true, 'a bundle that claims nothing');
  assert.equal(satisfiesMin('4.0.0-beta.21', ''), true);
});

test('a manifest that says nothing usable reads as a bundle making no claim', () => {
  assert.deepEqual(parseBundleManifest('not json at all'), { version: null, minCore: null });
  assert.deepEqual(parseBundleManifest('[]'), { version: null, minCore: null });
  assert.deepEqual(parseBundleManifest('{"version": 6}'), { version: null, minCore: null });
  assert.deepEqual(parseBundleManifest('{"version":" 6.1.0 ","minCore":"4.0.0-beta.22"}'), {
    version: '6.1.0',
    minCore: '4.0.0-beta.22',
  });
  // Every bundle released before manifests existed lands here, and must stay installable.
  assert.deepEqual(readBundleManifest(bundleAt({ 'index.html': '<html>' })), {
    version: null,
    minCore: null,
  });
});

test('the preflight refuses exactly the bundles this core cannot serve', () => {
  const running = '4.0.0-beta.21';
  assert.equal(rejectIfCoreTooOld(running, { version: '6.0.0', minCore: null }), null);
  assert.equal(rejectIfCoreTooOld(running, { version: '6.1.0', minCore: '4.0.0-beta.21' }), null);
  assert.deepEqual(rejectIfCoreTooOld(running, { version: '7.0.0', minCore: '4.0.0-beta.30' }), {
    requiredCore: '4.0.0-beta.30',
    runningCore: running,
  });
});

test('an installed bundle is reported with whether it fits the core serving it', () => {
  const publicDir = mkdtempSync(join(tmpdir(), 'sonn-public-'));
  mkdirSync(join(publicDir, 'admin'));
  mkdirSync(join(publicDir, 'player'));
  writeFileSync(
    join(publicDir, 'admin', 'version.json'),
    JSON.stringify({ version: '6.1.0', minCore: '4.0.0-beta.21' }),
  );
  writeFileSync(
    join(publicDir, 'player', 'version.json'),
    JSON.stringify({ version: '9.9.9', minCore: '5.0.0' }),
  );

  assert.deepEqual(describeBundle(publicDir, 'admin', '4.0.0-beta.21'), {
    version: '6.1.0',
    minCore: '4.0.0-beta.21',
    installed: '6.1.0',
    satisfied: true,
  });
  // A core downgrade is the way an already-installed bundle stops fitting: the update gate
  // cannot help once the files are in place, so the status has to say so instead.
  assert.equal(describeBundle(publicDir, 'player', '4.0.0-beta.21').satisfied, false);
});

test('a core that asks nothing of its bundles says so, rather than guessing', () => {
  const dir = bundleAt({
    'package.json': JSON.stringify({ sonn: { minAdminUi: null, minPlayer: '0.3.0' } }),
  });
  assert.deepEqual(readCoreBundleRequirements(join(dir, 'package.json')), {
    adminUi: null,
    player: '0.3.0',
  });
  assert.deepEqual(readCoreBundleRequirements(join(dir, 'absent.json')), {
    adminUi: null,
    player: null,
  });
});

test('info reports both bundles, so the console is no longer the one part unnamed', () => {
  const publicDir = mkdtempSync(join(tmpdir(), 'sonn-public-'));
  mkdirSync(join(publicDir, 'admin'));
  writeFileSync(
    join(publicDir, 'admin', 'version.json'),
    JSON.stringify({ version: '6.1.0', minCore: '4.0.0-beta.21' }),
  );

  const sent: { status?: number; body?: any } = {};
  const deps = {
    isAuthenticated: () => true,
    log: { error: () => {}, warn: () => {} },
    configPort: {
      getConfig: () => ({
        system: {
          audioserver: { name: 'T', macId: 'M', paired: true, setupComplete: true, extensions: [] },
          miniserver: {},
          users: [{ username: 'admin', password: 'secret', admin: true }],
        },
        zones: [],
      }),
    },
    groupManager: {},
    snapcastCore: {},
    sonnCorePeers: {},
    runtimeConfig: { loxone: { firmwareVersion: 'f', apiVersion: 'a' }, http: { publicDir } },
    readJsonBody: async () => null,
    sendJson: (_res: ServerResponse, status: number, body: unknown) => {
      sent.status = status;
      sent.body = body;
    },
  } as any;

  const route = buildMiscRoutes(deps).find((r) => r.pattern.source === /^\/info$/.source);
  route!.handler({} as IncomingMessage, {} as ServerResponse, [] as any, '/info');

  assert.equal(sent.status, 200);
  assert.equal(sent.body.adminUi.installed, '6.1.0');
  assert.equal(sent.body.adminUi.minCore, '4.0.0-beta.21');
  // Never fetched: absent, not an error, and reported the same shape so the UI has one
  // branch rather than two.
  assert.equal(sent.body.player.installed, null);
  assert.equal(sent.body.player.satisfied, true);
  assert.ok('requires' in sent.body, 'the other direction is reported even when unset');
});

/*
 * Dev is exempt. It is the one branch whose version number is behind its own code — it
 * carries the endpoints of the next release while still calling itself the last one — so a
 * minimum written against those endpoints refuses a bundle the server can serve. Nobody runs
 * dev except to try a fix, and what they need there is the newest of everything.
 */

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a dev build is one that says so, never one that failed to say otherwise', () => {
  const clean = { BUILD_CHANNEL: undefined, BUILD_TIMESTAMP: undefined };
  assert.equal(withEnv({ ...clean, BUILD_CHANNEL: 'dev' }, isDevBuild), true);
  assert.equal(withEnv({ ...clean, BUILD_CHANNEL: 'beta' }, isDevBuild), false);
  assert.equal(withEnv({ ...clean, BUILD_CHANNEL: 'stable' }, isDevBuild), false);
  // Older images predate BUILD_CHANNEL and stamp the channel into the build id.
  assert.equal(withEnv({ ...clean, BUILD_TIMESTAMP: 'dev-20260912' }, isDevBuild), true);
  assert.equal(withEnv({ ...clean, BUILD_TIMESTAMP: 'testing-20260912' }, isDevBuild), false);

  /*
   * The one that matters. `readBuildChannel` answers `dev` for anything that does not claim
   * otherwise, which is right for a warning and wrong for a permission: a server-dist tarball
   * unpacked outside a repository declares nothing, and must not inherit what dev may do.
   * Asserted from a working directory with no `.git`, which is exactly that deployment.
   */
  const nowhere = mkdtempSync(join(tmpdir(), 'sonn-nogit-'));
  const cwd = process.cwd();
  process.chdir(nowhere);
  try {
    assert.equal(withEnv(clean, isDevBuild), false, 'silence is not a claim to be dev');
  } finally {
    process.chdir(cwd);
  }
});
