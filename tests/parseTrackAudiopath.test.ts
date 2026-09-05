import assert from 'node:assert/strict';
import { test } from './testHarness';
import { parseTrackAudiopath, encodeAudiopath } from '../src/domain/zones/audiopath';

// Six stream services each parsed this themselves, from copies of one another.
// The copies drifted: four compared the unstripped kind to 'track' and so turned
// down a library track outright, while Apple normalised the prefix first.

test('a service-native track names its service, kind and id', () => {
  const parsed = parseTrackAudiopath('deezer:track:12345');
  assert.deepEqual(parsed, {
    providerKey: 'deezer',
    kind: 'track',
    id: '12345',
    isLibrary: false,
  });
});

test('an account slug is peeled off the key, not read as the kind', () => {
  // A naive `:` split reads `1ryw2i` as the kind and rejects the path — which is
  // what broke YouTube Music browsing once a second account existed.
  const parsed = parseTrackAudiopath('ytmusic:1ryw2i:track:abc');
  assert.equal(parsed?.providerKey, 'ytmusic:1ryw2i');
  assert.equal(parsed?.kind, 'track');
  assert.equal(parsed?.id, 'abc');
});

test('a library kind is stripped and reported as a flag', () => {
  const parsed = parseTrackAudiopath('applemusic:library-track:i.abc');
  assert.equal(parsed?.kind, 'track', 'callers compare one thing');
  assert.equal(parsed?.isLibrary, true);
  assert.equal(parsed?.id, 'i.abc');
});

test('every service reads a library track the same way now', () => {
  // Deezer, Tidal, YouTube Music and SoundCloud used to return null here.
  for (const service of ['deezer', 'tidal', 'ytmusic', 'soundcloud', 'applemusic']) {
    const parsed = parseTrackAudiopath(`${service}:library-track:x1`);
    assert.equal(parsed?.kind, 'track', service);
    assert.equal(parsed?.isLibrary, true, service);
  }
});

test('the legacy Loxone-bridged form still resolves', () => {
  const parsed = parseTrackAudiopath('spotify@bridge-applemusic-djq5zp:track:1791883667');
  assert.equal(parsed?.providerKey, 'spotify@bridge-applemusic-djq5zp');
  assert.equal(parsed?.kind, 'track');
  assert.equal(parsed?.id, '1791883667');
});

test('an encoded id comes back decoded', () => {
  const encoded = encodeAudiopath('1791883667', 'track', 'applemusic', true);
  const parsed = parseTrackAudiopath(encoded);
  assert.equal(parsed?.id, '1791883667', `from ${encoded}`);
});

test('a kind other than track is reported, not swallowed', () => {
  assert.equal(parseTrackAudiopath('deezer:album:a1')?.kind, 'album');
  assert.equal(parseTrackAudiopath('deezer:artist:r1')?.kind, 'artist');
  assert.equal(parseTrackAudiopath('applemusic:library-playlist:p.1')?.kind, 'playlist');
});

test('a path with nothing to identify is refused', () => {
  assert.equal(parseTrackAudiopath(''), null);
  assert.equal(parseTrackAudiopath('deezer'), null);
  assert.equal(parseTrackAudiopath('deezer:track'), null);
  assert.equal(parseTrackAudiopath('deezer:track:'), null);
  assert.equal(parseTrackAudiopath(':track:x'), null);
});

test('an id keeps its own colons', () => {
  const parsed = parseTrackAudiopath('musicassistant:track:library://track/713');
  assert.equal(parsed?.id, 'library://track/713');
});
