import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  asId,
  buildDrmCacheKey,
  buildLicenseHeaders,
  buildStreamHeaders,
  extractStreamUrl,
  normalizeLicenseUrl,
  normalizeSalableAdamId,
  resolvePaceInput,
  sanitizeProxyHeaders,
} from '../src/adapters/content/providers/applemusic/appleMusicStreamHelpers';
import type { StreamingServiceConfig } from '../src/domain/config/types';

// These were private methods inside a 1608-line class whose every entry point talks to amp-api,
// so nothing could reach them. Two of them decide what a listener's Apple Music credentials are
// forwarded to, which is the reason this file exists rather than tidiness.

// ── what leaves the server ─────────────────────────────────────────────────────

const CREDENTIALS = {
  authorization: 'Bearer developer-token',
  Authorization: 'Bearer developer-token',
  'Media-User-Token': 'the-listener',
  'Music-User-Token': 'the-listener',
  origin: 'https://music.apple.com',
  referer: 'https://music.apple.com/',
  'user-agent': 'Sonn',
  Host: 'should-never-be-forwarded',
};

// Apple's blob store serves the audio itself and has no business knowing who is listening.
// A user token sent there is a credential handed to a CDN, and it would keep working.
test('nothing that identifies the listener is sent to the blob store', () => {
  const out = sanitizeProxyHeaders('https://aod.itunes.blobstore.apple.com/x.m4a', CREDENTIALS)!;
  for (const key of [
    'authorization',
    'Authorization',
    'Media-User-Token',
    'Music-User-Token',
    'origin',
    'referer',
  ]) {
    assert.ok(!(key in out), `${key} must not reach the blob store`);
  }
  assert.equal(out['user-agent'], 'Sonn', 'and the rest of the request is left alone');
});

// The same headers on an amp-api host are exactly what authenticates the request, so stripping
// them there would turn a working stream into a 401.
test('the same credentials do reach Apple itself', () => {
  const out = sanitizeProxyHeaders('https://amp-api.music.apple.com/v1/x', CREDENTIALS)!;
  assert.equal(out.authorization, 'Bearer developer-token');
  assert.equal(out['Media-User-Token'], 'the-listener');
});

// Host always goes, on every target: a forwarded Host names our own server and makes the
// upstream answer for a name it does not serve.
test('the Host header never travels, wherever the request is going', () => {
  for (const url of ['https://amp-api.music.apple.com/v1/x', 'https://x.blobstore.apple.com/y']) {
    const out = sanitizeProxyHeaders(url, CREDENTIALS)!;
    assert.ok(!('Host' in out) && !('host' in out), url);
  }
});

test('a target that is not a URL is treated as untrusted, not as Apple', () => {
  // An unparseable target yields an empty host, which matches no allowlisted domain — so the
  // credentials are kept rather than dropped. Pinned because the `catch` makes it look accidental.
  const out = sanitizeProxyHeaders('not a url', CREDENTIALS)!;
  assert.equal(out.authorization, 'Bearer developer-token');
  assert.ok(!('Host' in out));
});

test('headers are only ever removed, never invented', () => {
  assert.equal(sanitizeProxyHeaders('https://x/', undefined), undefined);
  assert.deepEqual(sanitizeProxyHeaders('https://x/', {}), {});
});

// The other direction: what we send upstream is an allowlist, so a header added anywhere
// upstream of here cannot ride along.
test('only the eight allowlisted headers go upstream with a stream request', () => {
  const out = buildStreamHeaders({
    authorization: 'Bearer x',
    'media-user-token': 'listener',
    'user-agent': 'Sonn',
    cookie: 'session=secret',
    'x-forwarded-for': '10.0.0.5',
    'set-cookie': 'a=b',
    accept: '*/*',
    empty: '',
  })!;
  assert.deepEqual(Object.keys(out).sort(), [
    'accept',
    'authorization',
    'media-user-token',
    'user-agent',
  ]);
  assert.ok(!('cookie' in out) && !('x-forwarded-for' in out));
});

test('an allowlisted header with no value is dropped rather than sent empty', () => {
  assert.equal(buildStreamHeaders({ authorization: '' }), undefined, 'and nothing left means nothing sent');
});

// ── the license request ────────────────────────────────────────────────────────

test('the license request finds the user token whichever way it was spelled', () => {
  for (const key of [
    'media-user-token',
    'music-user-token',
    'Media-User-Token',
    'Music-User-Token',
  ]) {
    const out = buildLicenseHeaders({ [key]: 'listener' });
    assert.equal(out['media-user-token'], 'listener', key);
  }
});

test('the license request always names Apple as its origin', () => {
  const out = buildLicenseHeaders({});
  assert.equal(out.origin, 'https://music.apple.com');
  assert.equal(out.referer, 'https://music.apple.com/');
  assert.equal(out['content-type'], 'application/json;charset=utf-8');
  // Nothing is invented for headers that were not supplied.
  assert.ok(!('authorization' in out) && !('media-user-token' in out) && !('user-agent' in out));
});

// Apple hands out license URLs on the iTunes host that only answer on the Music one.
test('a license URL on the old iTunes host is moved to the Music host', () => {
  assert.equal(
    normalizeLicenseUrl('https://play.itunes.apple.com/WebObjects/MZPlay.woa/x'),
    'https://play.music.apple.com/WebObjects/MZPlay.woa/x',
  );
  assert.equal(normalizeLicenseUrl('https://play.music.apple.com/x'), 'https://play.music.apple.com/x');
  assert.equal(normalizeLicenseUrl(undefined), null);
  assert.equal(normalizeLicenseUrl(''), null);
});

// ── ids and shapes ─────────────────────────────────────────────────────────────

// A library track id arrives prefixed (`i.123456`); the salable id Apple wants is the number.
test('a prefixed library id is reduced to the number Apple asks for', () => {
  assert.equal(normalizeSalableAdamId('i.1234567'), '1234567');
  assert.equal(normalizeSalableAdamId('  l.999  '), '999');
  // A plain catalog id, or anything that is not that shape, is passed through untouched.
  assert.equal(normalizeSalableAdamId('1234567'), '1234567');
  assert.equal(normalizeSalableAdamId('ab.123'), 'ab.123');
  assert.equal(normalizeSalableAdamId('i.12a'), 'i.12a');
});

// The DRM cache is keyed by id *and* by which catalogue it came from: a library track and a
// catalog track can share a number and do not share a key.
test('a library track and a catalog track never share a DRM cache entry', () => {
  assert.equal(buildDrmCacheKey('123', true), 'library:123');
  assert.equal(buildDrmCacheKey('123', false), 'catalog:123');
  assert.notEqual(buildDrmCacheKey('123', true), buildDrmCacheKey('123', false));
});

// Apple has moved where it puts the HLS URL more than once, so eleven shapes are tried. The
// order is the contract: the first shape that answers wins.
test('the stream URL is found in whichever shape the response used', () => {
  assert.equal(extractStreamUrl({ hlsUrl: 'a' }), 'a');
  assert.equal(extractStreamUrl({ hlsURL: 'b' }), 'b');
  assert.equal(extractStreamUrl({ assets: [{ URL: 'c' }] }), 'c');
  assert.equal(extractStreamUrl({ assets: [{}, { url: 'd' }] }), 'd', 'the first asset that has one');
  assert.equal(extractStreamUrl({ streams: { hls: { url: 'e' } } }), 'e');
  // Earlier shapes win over later ones.
  assert.equal(extractStreamUrl({ hlsUrl: 'first', url: 'second' }), 'first');
  // An empty string is not an answer.
  assert.equal(extractStreamUrl({ hlsUrl: '', url: 'real' }), 'real');
  assert.equal(extractStreamUrl({}), null);
  assert.equal(extractStreamUrl(null), null);
});

test('an id is a trimmed non-empty string or nothing at all', () => {
  assert.equal(asId(12345), '12345');
  assert.equal(asId('  x  '), 'x');
  assert.equal(asId(''), undefined);
  assert.equal(asId('   '), undefined);
  assert.equal(asId(null), undefined);
  assert.equal(asId(undefined), undefined);
});

// Input pacing defaults off for faster startup, and only an explicit boolean turns it on —
// so a bridge that has never been configured for it is not silently paced.
test('input pacing is off unless a bridge says otherwise in so many words', () => {
  assert.equal(resolvePaceInput({} as StreamingServiceConfig), false);
  assert.equal(resolvePaceInput({ appleMusicPaceInput: true } as StreamingServiceConfig), true);
  assert.equal(resolvePaceInput({ appleMusicPaceInput: false } as StreamingServiceConfig), false);
  assert.equal(
    resolvePaceInput({ appleMusicPaceInput: 'true' } as unknown as StreamingServiceConfig),
    false,
    'a string is not a boolean, and guessing here would pace a stream nobody asked to pace',
  );
});
