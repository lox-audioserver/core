import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { makeOutputDiscoveryFake } from './fakes/outputDiscovery';
import {
  buildTransportsRoutes,
  type TransportsHandlerDeps,
} from '../src/adapters/http/adminApi/transports/transportsHandlers';
import type { OutputDiscoveryPort } from '../src/ports/OutputDiscoveryPort';

type Sent = { status: number; body: any };

function harness(discovery: OutputDiscoveryPort) {
  const sent: Sent[] = [];
  const warnings: string[] = [];
  const deps = {
    log: {
      warn: (msg: string) => warnings.push(msg),
      info: () => {},
      debug: () => {},
      error: () => {},
    },
    discovery,
    configPort: {} as never,
    mdns: {} as never,
    snapcastCore: {} as never,
    squeezeliteCore: {} as never,
    musicAssistantStreamService: {} as never,
    stateControllerDefinitions: [],
    readJsonBody: async () => ({}),
    sendJson: (_res: ServerResponse, status: number, body: unknown) => {
      sent.push({ status, body });
    },
  } as unknown as TransportsHandlerDeps;
  return { routes: buildTransportsRoutes(deps), sent, warnings };
}

const req = (url: string) => ({ url, method: 'GET', headers: {} }) as IncomingMessage;
const res = {} as ServerResponse;

/** Dispatches like the admin router does: match the path, then hand the handler its four args. */
async function call(routes: ReturnType<typeof harness>['routes'], path: string): Promise<void> {
  const found = routes.find((r) => r.method === 'GET' && r.pattern.test(path));
  assert.ok(found, `no GET route for ${path}`);
  const match = path.match(found!.pattern);
  assert.ok(match, `pattern did not match ${path}`);
  await found!.handler(req(path), res, match!, path);
}

// These four routes could not be tested at all before discovery was a port: they imported the
// airplay, cast, dlna and sonos modules directly, so exercising one meant waiting on real mDNS
// and SSDP answers from real hardware.
test('a device scan answers with what discovery found', async () => {
  const h = harness(
    makeOutputDiscoveryFake({
      airplay: async () => [
        { id: 'a1', name: 'Kitchen', host: 'kitchen.local', port: 7000, protocol: 'airplay' },
      ],
    }),
  );
  await call(h.routes, '/transports/airplay/devices');
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.status, 200);
  assert.deepEqual(
    h.sent[0]!.body.devices.map((d: { name: string }) => d.name),
    ['Kitchen'],
  );
});

// A protocol that throws must not take the admin screen down with it: the route reports its own
// failure and names which scan it was.
test('a scan that throws is reported as that protocol failing, not as a crash', async () => {
  const h = harness(
    makeOutputDiscoveryFake({
      sonos: async () => {
        throw new Error('ssdp socket refused');
      },
    }),
  );
  await call(h.routes, '/transports/sonos/devices');
  assert.equal(h.sent[0]!.status, 500);
  assert.equal(h.sent[0]!.body.error, 'sonos-discovery-failed');
  assert.deepEqual(h.warnings, ['sonos discovery failed']);
});

// The picker is fed from the port's own catalogue, and two entries are deliberately withheld:
// `spotify` and `sendspin-cast` are not outputs a user picks.
test('the transport list hides the entries that are not user-pickable', async () => {
  const h = harness(
    makeOutputDiscoveryFake({
      definitions: [
        { id: 'sendspin', label: 'Sendspin', fields: [] },
        { id: 'spotify', label: 'Spotify', fields: [] },
        { id: 'sendspin-cast', label: 'Cast', fields: [] },
      ],
    }),
  );
  await call(h.routes, '/transports');
  assert.deepEqual(
    h.sent[0]!.body.transports.map((t: { id: string }) => t.id),
    ['sendspin'],
  );
});
