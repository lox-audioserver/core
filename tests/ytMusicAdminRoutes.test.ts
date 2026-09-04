import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { makeYtMusicAdminFake } from './fakes/ytMusicAdmin';
import {
  buildYtMusicRoutes,
  type YtMusicHandlerDeps,
} from '../src/adapters/http/adminApi/ytmusic/ytmusicHandlers';
import { buildYtDlpRoutes } from '../src/adapters/http/adminApi/ytdlp/ytdlpHandlers';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { YtMusicAdminPort } from '../src/ports/YtMusicAdminPort';
import type { Route } from '../src/adapters/http/adminApi/routeTypes';

type Sent = { status: number; body: any };

const configWith = (bridges: unknown[]) =>
  ({
    getConfig: () => ({ content: { streamingServices: bridges } }),
  }) as unknown as ConfigPort;

function harness(admin: YtMusicAdminPort, bridges: unknown[] = [], body: unknown = {}) {
  const sent: Sent[] = [];
  const deps = {
    log: { warn() {}, info() {}, debug() {}, error() {} },
    ytMusicAdmin: admin,
    configPort: configWith(bridges),
    readJsonBody: async () => body,
    sendJson: (_res: ServerResponse, status: number, payload: unknown) => {
      sent.push({ status, body: payload });
    },
  } as unknown as YtMusicHandlerDeps;
  return { deps, sent };
}

const req = (url: string) => ({ url, method: 'GET', headers: {} }) as IncomingMessage;

async function call(routes: Route[], method: string, path: string): Promise<void> {
  const found = routes.find((r) => r.method === method && r.pattern.test(path));
  assert.ok(found, `no ${method} route for ${path}`);
  const match = path.match(found!.pattern)!;
  await found!.handler(req(path), {} as ServerResponse, match, path);
}

// None of these three routes could be tested before the YouTube stack became a port: status
// pings a PO Token server, the install runs pip, and the yt-dlp update downloads a release.

test('ytmusic status reports the cookie and PO Token state per configured bridge', async () => {
  const h = harness(
    makeYtMusicAdminFake({
      authStatus: () => ({ state: 'expired', checkedAt: 42, message: 'paste a new cookie' }),
      potPluginStatus: async () => ({ installed: '1.2.0', latest: '1.3.0', updateAvailable: true }),
      pingPotServer: async () => ({ ok: true, version: '0.9', error: null }),
    }),
    [{ id: 'ytm1', provider: 'ytmusic', enabled: true, ytmusicPoTokenUrl: 'http://pot:4416' }],
  );
  await call(buildYtMusicRoutes(h.deps), 'GET', '/ytmusic/status');

  const body = h.sent[0]!.body;
  assert.equal(h.sent[0]!.status, 200);
  assert.equal(body.potPlugin.updateAvailable, true);
  assert.equal(body.bridges.length, 1);
  assert.equal(body.bridges[0].cookie.state, 'expired');
  assert.equal(body.bridges[0].potServer.ok, true);
});

// A failed install is the reach out to GitHub failing, not a bad request — the screen has to be
// able to tell those apart, so the status code is part of the contract.
test('a PO Token plugin install that fails answers 502 with the reason', async () => {
  const h = harness(
    makeYtMusicAdminFake({
      installPotPlugin: async () => ({ ok: false, error: 'pip exited 1' }),
    }),
  );
  await call(buildYtMusicRoutes(h.deps), 'POST', '/ytmusic/pot-plugin/install');
  assert.equal(h.sent[0]!.status, 502);
  assert.equal(h.sent[0]!.body.error, 'pip exited 1');
});

test('a successful install answers with the fresh status and what it replaced', async () => {
  const h = harness(
    makeYtMusicAdminFake({
      installPotPlugin: async () => ({ ok: true, version: '1.3.0', previous: '1.2.0' }),
      potPluginStatus: async () => ({ installed: '1.3.0', latest: '1.3.0', updateAvailable: false }),
    }),
  );
  await call(buildYtMusicRoutes(h.deps), 'POST', '/ytmusic/pot-plugin/install');
  assert.equal(h.sent[0]!.status, 200);
  assert.equal(h.sent[0]!.body.installed, '1.3.0');
  assert.equal(h.sent[0]!.body.previous, '1.2.0');
});

test('yt-dlp status reports which binary would actually run', async () => {
  const h = harness(
    makeYtMusicAdminFake({
      ytDlpStatus: async () => ({
        version: '2026.01.01',
        source: '/data/bin/yt-dlp',
        managed: true,
        latest: '2026.02.01',
        updateAvailable: true,
      }),
    }),
  );
  await call(buildYtDlpRoutes(h.deps as never), 'GET', '/ytdlp/status');
  assert.equal(h.sent[0]!.status, 200);
  assert.equal(h.sent[0]!.body.managed, true);
  assert.equal(h.sent[0]!.body.updateAvailable, true);
});
