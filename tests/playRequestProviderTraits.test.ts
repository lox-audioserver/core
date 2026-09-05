import assert from 'node:assert/strict';
import { test } from './testHarness';
import { resolveQueueAuthority } from '../src/application/zones/playback/queueOps';
import { resolvePlayRequest } from '../src/application/zones/playback/playRequestResolution';
import {
  decodeAudiopath,
  encodeAudiopath,
  isBridgeQueueService,
  hasSlowStreamResolution,
} from '../src/domain/zones/audiopath';
import {
  normalizeSpotifyAudiopath,
  sanitizeStation,
} from '../src/application/zones/helpers/queueHelpers';
import type { ZoneAudioHelpers } from '../src/application/zones/internal/zoneAudioHelpers';
import type { ResolvePlayRequestDeps } from '../src/application/zones/playback/playRequestResolution';

// A play request used to carry twelve per-service booleans that every consumer
// collapsed straight back into a disjunction. It carries the provider now, and
// the disjunctions are named properties. These pin the three that exist.

// ── the properties themselves ────────────────────────────────────────────────

test('a bridged service with queue handling is recognised as one', () => {
  for (const service of ['applemusic', 'deezer', 'tidal', 'ytmusic', 'soundcloud']) {
    assert.equal(isBridgeQueueService(service), true, service);
  }
  // Bridged, but never had queue handling of its own.
  assert.equal(isBridgeQueueService('youtube'), false);
  assert.equal(isBridgeQueueService('spotify'), false);
  assert.equal(isBridgeQueueService(null), false);
});

test('only the yt-dlp-backed services count as slow to resolve', () => {
  assert.equal(hasSlowStreamResolution('ytmusic'), true);
  assert.equal(hasSlowStreamResolution('youtube'), true);
  assert.equal(hasSlowStreamResolution('applemusic'), false);
  assert.equal(hasSlowStreamResolution(null), false);
});

// ── queue authority ──────────────────────────────────────────────────────────

test('a service that owns its own listing keeps the queue local', () => {
  for (const provider of ['applemusic', 'deezer', 'tidal', 'soundcloud']) {
    assert.equal(
      resolveQueueAuthority({ isMusicAssistant: true, provider }),
      'local',
      provider,
    );
  }
});

test('a path only Music Assistant claims hands it the queue', () => {
  assert.equal(
    resolveQueueAuthority({ isMusicAssistant: true, provider: null }),
    'musicassistant',
  );
});

test('ytmusic does not force the queue local, unlike its four siblings', () => {
  // Preserved from the previous implementation, which left ytmusic out of that
  // list. Pinned so the difference is visible rather than accidental.
  assert.equal(
    resolveQueueAuthority({ isMusicAssistant: true, provider: 'ytmusic' }),
    'musicassistant',
  );
});

test('a request nobody claims is a local queue', () => {
  assert.equal(
    resolveQueueAuthority({ isMusicAssistant: false, provider: null }),
    'local',
  );
});

// ── the resolver ─────────────────────────────────────────────────────────────

function makeDeps(provider: string | null): ResolvePlayRequestDeps {
  const audioHelpers = {
    providerForAudiopath: () => provider,
    isMusicAssistantAudiopath: () => false,
    isSpotifyAudiopath: () => false,
    deriveRadioStationLabel: () => undefined,
  } as unknown as ZoneAudioHelpers;
  return {
    audioHelpers,
    parseParentContext: () => null,
    classifyIsRadio: () => false,
    decodeAudiopath,
    encodeAudiopath,
    normalizeSpotifyAudiopath,
    sanitizeStation,
    providerForAudiopath: () => provider,
    getMusicAssistantProviderId: () => 'musicassistant',
  };
}

test('a resolved play request carries the provider that owns it', () => {
  const req = resolvePlayRequest({
    uri: 'deezer:track:t1',
    type: 'serviceplay',
    deps: makeDeps('deezer'),
  });

  assert.equal(req.provider, 'deezer');
  assert.equal(isBridgeQueueService(req.provider), true);
});

test('a request nothing bridged owns has no provider', () => {
  const req = resolvePlayRequest({
    uri: 'library://track/one',
    type: 'serviceplay',
    deps: makeDeps(null),
  });

  assert.equal(req.provider, null);
  assert.equal(isBridgeQueueService(req.provider), false);
});

test('a parent container becomes the queue source for apple music only', () => {
  const parent = 'applemusic:library-album:al.1';
  const withParent = (provider: string): ResolvePlayRequestDeps => ({
    ...makeDeps(provider),
    parseParentContext: () => ({ parent, startItem: `${provider}:track:t1`, startIndex: 0 }),
  });

  const apple = resolvePlayRequest({
    uri: 'applemusic:track:t1',
    type: 'serviceplay',
    deps: withParent('applemusic'),
  });
  assert.equal(apple.queueSourcePath, parent);

  const deezer = resolvePlayRequest({
    uri: 'deezer:track:t1',
    type: 'serviceplay',
    deps: withParent('deezer'),
  });
  assert.equal(deezer.queueSourcePath, 'deezer:track:t1');
});
