import assert from 'node:assert/strict';
import { test } from './testHarness';
import { searchRadioStations } from '../src/adapters/content/providers/radiobrowser/radioBrowserAdmin';

// What the admin search shows is not what the index returns. It is a community list: the
// same station is submitted a dozen times, half the logos point at hosts that are gone, and
// a station keeps two urls — the one it publishes and the one that url led to at the last
// check. These are the rules that turn that into rows a person can choose between.

type Station = Record<string, unknown>;

/**
 * Answer the mirror list and one search, and record what was asked for.
 *
 * The mirror list has to answer too: the client resolves a host before it can search, and a
 * silent failure there would look exactly like a search that found nothing.
 */
function stubIndex(stations: Station[]): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    calls.push(url);
    const body = url.includes('/json/servers') ? [{ name: 'test.invalid' }] : stations;
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const station = (over: Station): Station => ({
  stationuuid: 'uuid-1',
  name: 'Test FM',
  url: 'http://example.com/stream.pls',
  url_resolved: 'http://cdn17.example.com/stream.mp3',
  votes: 10,
  ...over,
});

test('a station keeps the url it publishes, not the one it resolved to', async () => {
  const stub = stubIndex([station({})]);
  try {
    const [hit] = await searchRadioStations('test');
    // The pointer is how a station moves servers without every listener re-adding it, and
    // the proxy follows pointers. Freezing today's cdn hostname into a saved entry is the
    // one choice that cannot be undone later.
    assert.equal(hit?.stream, 'http://example.com/stream.pls');
  } finally {
    stub.restore();
  }
});

test('a station with no url of its own falls back to the resolved one', async () => {
  const stub = stubIndex([station({ url: '   ' })]);
  try {
    const [hit] = await searchRadioStations('test');
    assert.equal(hit?.stream, 'http://cdn17.example.com/stream.mp3');
  } finally {
    stub.restore();
  }
});

test('entries without a usable stream are dropped rather than shown as dead rows', async () => {
  const stub = stubIndex([
    station({ stationuuid: 'a', url: '', url_resolved: '' }),
    station({ stationuuid: 'b', url: 'not-a-url', url_resolved: '' }),
    station({ stationuuid: 'c', name: '  ' }),
    station({ stationuuid: 'd', name: 'Real FM' }),
  ]);
  try {
    const hits = await searchRadioStations('test');
    assert.deepEqual(hits.map((hit) => hit.name), ['Real FM']);
  } finally {
    stub.restore();
  }
});

test('the same stream listed twice appears once, keeping the better-known listing', async () => {
  const stub = stubIndex([
    station({ stationuuid: 'popular', name: 'Test FM', votes: 4000 }),
    station({ stationuuid: 'copy', name: 'TEST FM (copy)', votes: 3, url: 'http://example.com/stream.pls/' }),
    station({ stationuuid: 'other', name: 'Other FM', url: 'http://example.com/other.pls' }),
  ]);
  try {
    const hits = await searchRadioStations('test');
    assert.deepEqual(hits.map((hit) => hit.id), ['popular', 'other']);
  } finally {
    stub.restore();
  }
});

test('a bitrate filled in as bits is left off rather than shown as 320000 kbps', async () => {
  const stub = stubIndex([
    station({ stationuuid: 'a', codec: 'MP3', bitrate: 320000 }),
    station({ stationuuid: 'b', codec: 'MP3', bitrate: 128, url: 'http://example.com/b.pls' }),
  ]);
  try {
    const hits = await searchRadioStations('test');
    assert.equal(hits[0]?.bitrate, undefined);
    assert.equal(hits[1]?.bitrate, 128);
  } finally {
    stub.restore();
  }
});

test('an unknown codec and a logo that is not a url are left off', async () => {
  const stub = stubIndex([station({ codec: 'UNKNOWN', favicon: 'logo.png' })]);
  try {
    const [hit] = await searchRadioStations('test');
    assert.equal(hit?.codec, undefined);
    assert.equal(hit?.coverurl, undefined);
  } finally {
    stub.restore();
  }
});

test('an empty query never reaches the index', async () => {
  const stub = stubIndex([station({})]);
  try {
    assert.deepEqual(await searchRadioStations('   '), []);
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
});

test('the index is asked only for stations that passed its own last check', async () => {
  const stub = stubIndex([station({})]);
  try {
    await searchRadioStations('test');
    const search = stub.calls.find((url) => url.includes('/json/stations/search'));
    assert.ok(search, 'a search request must be made');
    assert.match(search, /hidebroken=true/);
    assert.match(search, /order=votes/);
  } finally {
    stub.restore();
  }
});
