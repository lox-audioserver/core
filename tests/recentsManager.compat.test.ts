import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import { createRecentsManager } from '../src/application/zones/recents/recentsManager';
import { buildBridgeRegistry } from '../src/domain/zones/bridgeIdentity';

// No bridged services configured: `normalizeForClient` asks for the registry to put the Loxone
// envelope back on a bridged path, and an empty one leaves every path as it is.
const EMPTY_REGISTRY = buildBridgeRegistry([]);

async function withTempCwd(fn: () => Promise<void>): Promise<void> {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lox-recents-test-'));
  process.chdir(tempDir);
  try {
    await fn();
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('recents manager normalizes local library items to client-compatible audiopath', async () => {
  await withTempCwd(async () => {
    await fs.mkdir(path.join(process.cwd(), 'data', 'recents'), { recursive: true });
    await fs.writeFile(
      path.join(process.cwd(), 'data', 'recents', '27.json'),
      JSON.stringify({
        ts: 1,
        items: [
          {
            audiopath: 'library://local/Ed_Sheeran_-_Play/03_Azizam.mp3',
            coverurl: '',
            owner: 'nouser',
            owner_id: 'nouser',
            service: 'library',
            serviceType: 2,
            title: 'Azizam',
            type: 2,
            album: 'Play',
            artist: 'Ed Sheeran',
          },
        ],
      }),
    );

    const recentsManager = createRecentsManager({
      notifier: { notifyRecentlyPlayedChanged: () => {} } as any,
      contentPort: { getDefaultSpotifyAccountId: () => null, getBridgeRegistry: () => EMPTY_REGISTRY } as any,
    });

    const result = await recentsManager.get(27);
    assert.match(result.items[0]?.audiopath ?? '', /^library:local:track:b64_/);
  });
});

test('recents manager maps legacy custom radio service to custom_stream', async () => {
  await withTempCwd(async () => {
    await fs.mkdir(path.join(process.cwd(), 'data', 'recents'), { recursive: true });
    await fs.writeFile(
      path.join(process.cwd(), 'data', 'recents', '15.json'),
      JSON.stringify({
        ts: 1,
        items: [
          {
            audiopath: 'https://example.com/radio.mp3',
            coverurl: '',
            owner: 'nouser',
            owner_id: 'nouser',
            service: 'custom',
            serviceType: 3,
            title: 'Web Radio',
            type: 3,
          },
        ],
      }),
    );

    const recentsManager = createRecentsManager({
      notifier: { notifyRecentlyPlayedChanged: () => {} } as any,
      contentPort: { getDefaultSpotifyAccountId: () => null, getBridgeRegistry: () => EMPTY_REGISTRY } as any,
    });

    const result = await recentsManager.get(15);
    assert.equal(result.items[0]?.service, 'custom_stream');
  });
});

test('a bridged track is recorded under its own identity, not doubled behind an account', async () => {
  await withTempCwd(async () => {
    const recentsManager = createRecentsManager({
      notifier: { notifyRecentlyPlayedChanged: () => {} } as any,
      contentPort: {
        getDefaultSpotifyAccountId: () => 'md123121',
        resolveMetadata: async () => null,
        getBridgeRegistry: () => EMPTY_REGISTRY,
      } as any,
    });

    // `resolveService` answers `spotify` for every bridged service — that is the Loxone view.
    // It must not decide that this path wants a Spotify account glued in front of it: doing so
    // stored `spotify@applemusic:applemusic:track:…`, which is what the readers downstream
    // have a special case for.
    await recentsManager.record(27, {
      audiopath: 'applemusic:track:b64_MTc5MTg4MzY2Nw==',
      user: 'applemusic',
      title: 'Something',
    } as any);

    const stored = await recentsManager.get(27);
    assert.equal(stored.items[0]?.audiopath, 'applemusic:track:b64_MTc5MTg4MzY2Nw==');
  });
});

test('a real Spotify track still gets its account', async () => {
  await withTempCwd(async () => {
    const recentsManager = createRecentsManager({
      notifier: { notifyRecentlyPlayedChanged: () => {} } as any,
      contentPort: {
        getDefaultSpotifyAccountId: () => 'md123121',
        resolveMetadata: async () => null,
        getBridgeRegistry: () => EMPTY_REGISTRY,
      } as any,
    });

    await recentsManager.record(27, {
      audiopath: 'spotify:track:2bJtJv5NGkYUFP6prU3WSg',
      user: 'nouser',
      title: 'Something',
    } as any);

    const stored = await recentsManager.get(27);
    assert.equal(stored.items[0]?.audiopath, 'spotify@md123121:track:2bJtJv5NGkYUFP6prU3WSg');
  });
});

// ── The Loxone item type per bridged service ─────────────────────────────────
// Four services had a branch each in `resolveService`, three of them identical.
// What actually differs is which word in the path means "container": an album
// for most, a playlist or artist for SoundCloud, which has no albums.

function makeRecentsManager() {
  return createRecentsManager({
    notifier: { notifyRecentlyPlayedChanged: () => {} } as any,
    contentPort: {
      getDefaultSpotifyAccountId: () => null,
      resolveMetadata: async () => null,
      getBridgeRegistry: () => EMPTY_REGISTRY,
    } as any,
  });
}

test('a bridged album is typed as a container, a track is not', () => {
  const recentsManager = makeRecentsManager();

  for (const service of ['applemusic', 'deezer', 'tidal']) {
    assert.equal(
      recentsManager.resolveService(`${service}:album:a1`).type,
      7,
      `${service} album`,
    );
    assert.equal(
      recentsManager.resolveService(`${service}:track:t1`).type,
      2,
      `${service} track`,
    );
  }
});

test('soundcloud reads playlists and artists as containers, having no albums', () => {
  const recentsManager = makeRecentsManager();

  assert.equal(recentsManager.resolveService('soundcloud:playlist:p1').type, 7);
  assert.equal(recentsManager.resolveService('soundcloud:artist:a1').type, 7);
  assert.equal(recentsManager.resolveService('soundcloud:track:t1').type, 2);
  // An album means nothing here, so it is not a container.
  assert.equal(recentsManager.resolveService('soundcloud:album:x1').type, 2);
});

test('every bridged service is reported to Loxone as spotify', () => {
  const recentsManager = makeRecentsManager();

  for (const service of ['applemusic', 'deezer', 'tidal', 'soundcloud']) {
    const resolved = recentsManager.resolveService(`${service}:track:t1`);
    assert.equal(resolved.service, 'spotify', service);
    assert.equal(resolved.serviceType, 3, service);
  }
});

test('a service with no recents handling of its own falls through to custom', () => {
  const recentsManager = makeRecentsManager();

  // ytmusic was never in that chain and is not in the table either.
  assert.equal(recentsManager.resolveService('ytmusic:track:t1').service, 'custom');
});

test('a youtube path is filed as local library, because nothing recognises it', () => {
  const recentsManager = makeRecentsManager();

  // Pre-dates this table and is not caused by it: detectServiceFromAudiopath has
  // no `youtube` case at all — the name is missing from both its checks and its
  // return type — so a youtube path takes the library default and its recents are
  // stored as a local file. Pinned as it stands rather than changed here.
  assert.equal(recentsManager.resolveService('youtube:track:t1').service, 'library');
});
