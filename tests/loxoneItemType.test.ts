import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  deriveLoxoneFileType,
  forLoxoneFolder,
  stripNeutralItemFields,
} from '../src/adapters/loxone/commands/utils/loxoneItems';
import { FileType } from '../src/domain/zones/enums';
import type { ContentItemKind } from '../src/domain/media/contentKind';
import type { ContentFolderItem } from '../src/ports/ContentTypes';
import { SpotifyAccountProvider } from '../src/adapters/content/providers/spotify/spotifyAccountProvider';
import { FakeSpotifyAccountProvider } from '../src/adapters/content/providers/spotify/fakeSpotifyAccountProvider';

const item = (over: Partial<ContentFolderItem> = {}): ContentFolderItem => ({
  id: 'x',
  name: 'X',
  ...over,
});

// What every kind renders as when the producer says nothing. Pinned rather than described:
// these are the numbers the Loxone app has always received for these rows, and the table in
// loxoneItems.ts is only correct in so far as it reproduces them.
test('a kind with no explicit type derives the FileType the app has always been sent', () => {
  const expected: Array<[ContentItemKind, FileType]> = [
    ['track', FileType.File],
    ['radio', FileType.File],
    ['episode', FileType.File],
    ['album', FileType.PlaylistBrowsable],
    ['artist', FileType.PlaylistBrowsable],
    ['playlist', FileType.PlaylistBrowsable],
    ['show', FileType.PlaylistBrowsable],
    ['category', FileType.PlaylistBrowsable],
    ['folder', FileType.Folder],
  ];
  for (const [kind, fileType] of expected) {
    assert.equal(deriveLoxoneFileType(item({ kind })), fileType, kind);
  }
});

// The reason `type` stays optional rather than being removed: four container values describe
// the same thing and differ only in the affordance, so a producer that needs one must be able
// to say so and be believed.
test('an explicit type wins over the kind it disagrees with', () => {
  const followable = item({ kind: 'playlist', type: FileType.PlaylistFollowable });
  assert.equal(deriveLoxoneFileType(followable), 12);

  const editable = item({ kind: 'playlist', type: FileType.PlaylistEditable });
  assert.equal(deriveLoxoneFileType(editable), 11);

  // A favourite is a Loxone menu construct with no kind of its own.
  assert.equal(deriveLoxoneFileType(item({ type: FileType.Favorite })), 4);
});

// The legacy path: providers that set `tag` and never `kind` are the majority, and their rows
// must not change now that `type` is derivable.
test('a tag-only item resolves through the same route as before', () => {
  assert.equal(deriveLoxoneFileType(item({ tag: 'album' })), FileType.PlaylistBrowsable);
  assert.equal(deriveLoxoneFileType(item({ tag: 'artist' })), FileType.PlaylistBrowsable);
  assert.equal(deriveLoxoneFileType(item({ tag: 'radio' })), FileType.File);
  // Nothing to go on at all: a container is the safe read, not a playable file.
  assert.equal(deriveLoxoneFileType(item()), FileType.Folder);
});

// This is the reason the local library cannot simply drop its `type`, and it is worth a test
// rather than a comment: the library tags a row by where it lives, and both its folders and its
// tracks carry `tag: 'nas'` *and* an audiopath. Nothing but `type` tells them apart, so an item
// tagged by storage that states neither `kind` nor `type` reads as a folder — which for a track
// is wrong. Migrating those rows means writing `kind`, not deleting `type`.
test('a storage tag alone cannot say whether a row is a track or a folder', () => {
  const playable = item({ tag: 'nas', audiopath: 'file:/a.flac' });
  assert.equal(deriveLoxoneFileType(playable), FileType.Folder, 'no kind, no type: reads as folder');
  assert.equal(deriveLoxoneFileType({ ...playable, type: FileType.File }), FileType.File);
  assert.equal(deriveLoxoneFileType({ ...playable, kind: 'track' }), FileType.File);
});

test('the wire carries type and tag, never kind', () => {
  const [wire] = stripNeutralItemFields([
    item({ kind: 'album', tag: 'album', audiopath: 'spotify:album:1' }),
  ]);
  assert.equal(wire!.type, FileType.PlaylistBrowsable);
  assert.equal(wire!.tag, 'album');
  assert.ok(!('kind' in wire!), 'kind must not reach the client');
});

test('an explicit type survives the trip to the wire unchanged', () => {
  const folder = forLoxoneFolder({
    id: 'f',
    name: 'Library',
    items: [item({ kind: 'playlist', tag: 'playlist', type: 12 }), item({ kind: 'track' })],
  });
  assert.deepEqual(
    folder.items.map((i) => i.type),
    [12, FileType.File],
  );
});

// The bug this field exists for: the same Spotify album came back as PlaylistBrowsable from
// search and PlaylistFollowable from the library, so whether the app drew a follow button
// depended on which screen you had found the record on. One rule in the provider now decides,
// and the number is derived — so the two routes cannot drift apart again.
test('a followable container renders the same wherever it was found', () => {
  const fromSearch = item({ kind: 'album', tag: 'album', followable: true });
  const fromLibrary = item({ kind: 'album', tag: 'album', followable: true, followed: false });
  assert.equal(deriveLoxoneFileType(fromSearch), FileType.PlaylistFollowable);
  assert.equal(deriveLoxoneFileType(fromLibrary), FileType.PlaylistFollowable);
});

// A bridged service reaches us addressed as `spotify` but cannot answer a follow query, and
// neither can any other provider — so nothing may advertise the control by default.
test('a container says browsable unless it claims it can be followed', () => {
  assert.equal(deriveLoxoneFileType(item({ kind: 'album' })), FileType.PlaylistBrowsable);
  assert.equal(
    deriveLoxoneFileType(item({ kind: 'album', followable: false })),
    FileType.PlaylistBrowsable,
  );
});

// `followable` upgrades a container and nothing else. A track with a follow toggle is a row the
// app cannot draw, so a producer that sets it there is ignored rather than believed.
test('followable cannot turn a playable row into a container', () => {
  assert.equal(deriveLoxoneFileType(item({ kind: 'track', followable: true })), FileType.File);
  assert.equal(deriveLoxoneFileType(item({ kind: 'folder', followable: true })), FileType.Folder);
});

// The rule at its source, on both classes that produce these rows. `FakeSpotifyAccountProvider`
// is how a bridged service (Apple Music and friends) is published as `spotify`, and
// `SpotifyServiceManager.getFollowState` refuses it on the same `fake` flag — so it must not
// advertise a control the server will not answer.
test('only a real Spotify account claims a row can be followed', () => {
  const options = {
    providerId: 'spotify@rudy',
    account: { id: 'rudy', refreshToken: 'stub' } as never,
    persistAccount: async () => null,
  };
  const real = new SpotifyAccountProvider(options);
  const bridged = new FakeSpotifyAccountProvider('applemusic', 'Apple Music', options);

  for (const kind of ['album', 'artist', 'playlist', 'show'] as const) {
    assert.equal(real.followable(kind), true, `real spotify ${kind}`);
    assert.equal(bridged.followable(kind), false, `bridged ${kind}`);
  }
  // Only those four: a follow query for anything else has no answer.
  for (const kind of ['track', 'episode', 'category', 'folder', 'radio'] as const) {
    assert.equal(real.followable(kind), false, `not followable: ${kind}`);
  }
});
