import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SomaFmProvider } from '../src/adapters/content/providers/somafm/somaFmProvider';
import { SomaFmClient } from '../src/adapters/content/providers/somafm/somaFmClient';

// SomaFM publishes one json file describing every channel. These are the rules for turning
// it into a folder: which of a channel's four streams to play, which of its three logos to
// show, and what to do on the day the feed cannot be reached.

type Channel = Record<string, unknown>;

function stubFeed(
  answer: () => { ok: boolean; channels?: Channel[] },
): { calls: number; restore: () => void } {
  const state = { calls: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    state.calls += 1;
    const result = answer();
    return {
      ok: result.ok,
      status: result.ok ? 200 : 503,
      json: async () => ({ channels: result.channels ?? [] }),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return {
    get calls() {
      return state.calls;
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const channel = (over: Channel = {}): Channel => ({
  id: 'groovesalad',
  title: 'Groove Salad',
  image: 'https://api.somafm.com/logos/120/gs120.png',
  largeimage: 'https://api.somafm.com/logos/256/gs256.png',
  xlimage: 'https://api.somafm.com/logos/512/gs512.png',
  playlists: [
    { url: 'https://api.somafm.com/groovesalad.pls', format: 'mp3', quality: 'highest' },
    { url: 'https://api.somafm.com/groovesalad130.pls', format: 'aac', quality: 'highest' },
    { url: 'https://api.somafm.com/groovesalad32.pls', format: 'aacp', quality: 'low' },
  ],
  ...over,
});

test('a channel plays the stream SomaFM lists first, and shows its largest logo', async () => {
  const feed = stubFeed(() => ({ ok: true, channels: [channel()] }));
  try {
    const folder = await new SomaFmProvider().getFolder('start', 0, 50);
    const [item] = folder?.items ?? [];
    // Their order is uniform across all 46 channels and best-first; taking the head of it
    // is deferring to them rather than ranking formats ourselves.
    assert.equal(item?.audiopath, 'https://api.somafm.com/groovesalad.pls');
    assert.equal(item?.coverurl, 'https://api.somafm.com/logos/512/gs512.png');
  } finally {
    feed.restore();
  }
});

test('a channel missing its logo falls back through the smaller ones', async () => {
  const feed = stubFeed(() => ({ ok: true, channels: [channel({ xlimage: '', largeimage: '' })] }));
  try {
    const folder = await new SomaFmProvider().getFolder('start', 0, 50);
    assert.equal(folder?.items[0]?.coverurl, 'https://api.somafm.com/logos/120/gs120.png');
  } finally {
    feed.restore();
  }
});

test('a channel with nothing to play is left out rather than listed as silence', async () => {
  const feed = stubFeed(() => ({
    ok: true,
    channels: [
      channel({ id: 'a', playlists: [] }),
      channel({ id: 'b', playlists: [{ url: 'rtsp://nope', format: 'mp3' }] }),
      channel({ id: 'c', title: '   ' }),
      channel({ id: 'd', title: 'Drone Zone' }),
    ],
  }));
  try {
    const folder = await new SomaFmProvider().getFolder('start', 0, 50);
    assert.deepEqual(folder?.items.map((item) => item.name), ['Drone Zone']);
    assert.equal(folder?.totalitems, 1);
  } finally {
    feed.restore();
  }
});

test('channels are listed by name, so the menu is in the same order next time', async () => {
  const feed = stubFeed(() => ({
    ok: true,
    channels: [
      channel({ id: 'u80s', title: 'Underground 80s' }),
      channel({ id: 'beatblender', title: 'Beat Blender' }),
      channel({ id: 'dronezone', title: 'Drone Zone' }),
    ],
  }));
  try {
    const folder = await new SomaFmProvider().getFolder('start', 0, 50);
    assert.deepEqual(folder?.items.map((item) => item.name), [
      'Beat Blender',
      'Drone Zone',
      'Underground 80s',
    ]);
  } finally {
    feed.restore();
  }
});

test('paging reports the whole list while returning one page of it', async () => {
  const feed = stubFeed(() => ({
    ok: true,
    channels: ['a', 'b', 'c', 'd'].map((id) => channel({ id, title: id.toUpperCase() })),
  }));
  try {
    const folder = await new SomaFmProvider().getFolder('start', 1, 2);
    assert.equal(folder?.totalitems, 4);
    assert.equal(folder?.start, 1);
    assert.deepEqual(folder?.items.map((item) => item.name), ['B', 'C']);
  } finally {
    feed.restore();
  }
});

test('the feed is fetched once and then kept, not asked for on every browse', async () => {
  const feed = stubFeed(() => ({ ok: true, channels: [channel()] }));
  try {
    const provider = new SomaFmProvider();
    await provider.getFolder('start', 0, 50);
    await provider.getFolder('start', 0, 50);
    assert.equal(feed.calls, 1);
  } finally {
    feed.restore();
  }
});

test('a feed that goes away leaves the channels it already had', async () => {
  let healthy = true;
  const feed = stubFeed(() =>
    healthy ? { ok: true, channels: [channel()] } : { ok: false },
  );
  try {
    // Straight at the client, because the expiry is its business and a zero TTL is what
    // makes the second call re-fetch — which is when the outage happens.
    const api = new SomaFmClient(0);
    assert.equal((await api.channels()).length, 1);
    healthy = false;
    // A list that empties out because somebody's wifi blinked is worse than a stale one.
    assert.deepEqual((await api.channels()).map((entry) => entry.title), ['Groove Salad']);
  } finally {
    feed.restore();
  }
});

test('only the start folder exists; anything else is not found', async () => {
  const feed = stubFeed(() => ({ ok: true, channels: [channel()] }));
  try {
    assert.equal(await new SomaFmProvider().getFolder('groovesalad', 0, 50), null);
    assert.equal(feed.calls, 0);
  } finally {
    feed.restore();
  }
});
