import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SonosOutput } from '../src/adapters/outputs/sonos/sonosOutput';
import { resolveSonosEndpointsByHost } from '../src/adapters/outputs/sonos/sonosDiscovery';

// Regression coverage for issue #374: a zone that names its Sonos by IP reported
// "no Sonos endpoints discovered" while the speaker answered every HTTP request we
// made. Endpoint resolution went out over SSDP, and multicast replies never reached
// the server — so the one path that already knew the address was the one path that
// waited for the network to volunteer it.

const HOST = '192.168.178.26';
const DESCRIPTION_URL = `http://${HOST}:1400/xml/device_description.xml`;

const DESCRIPTION_XML = `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <URLBase>http://${HOST}:1400/</URLBase>
  <device>
    <friendlyName>${HOST} - Sonos Play:5</friendlyName>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>/MediaRenderer/AVTransport/Control</controlURL>
        <eventSubURL>/MediaRenderer/AVTransport/Event</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <controlURL>/MediaRenderer/RenderingControl/Control</controlURL>
        <eventSubURL>/MediaRenderer/RenderingControl/Event</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>`;

/**
 * Serve the description over HTTP and nothing else, which is the shape of the
 * reported network: the speaker is reachable, the multicast path is not.
 */
function stubFetch(handler: (url: string) => { ok: boolean; body?: string }) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    calls.push(url);
    const result = handler(url);
    return {
      ok: result.ok,
      status: result.ok ? 200 : 404,
      text: async () => result.body ?? '',
    } as any;
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const describeOnly = (url: string) =>
  url === DESCRIPTION_URL ? { ok: true, body: DESCRIPTION_XML } : { ok: false };

test('sonos endpoints are read from the device description when the host is known', async () => {
  const fetchStub = stubFetch(describeOnly);
  try {
    const info = await resolveSonosEndpointsByHost(HOST);
    assert.ok(info, 'a reachable speaker must resolve without SSDP');
    assert.equal(info?.controlUrl, `http://${HOST}:1400/MediaRenderer/AVTransport/Control`);
    assert.equal(
      info?.renderingControlUrl,
      `http://${HOST}:1400/MediaRenderer/RenderingControl/Control`,
      'volume needs RenderingControl, so it has to come out of the same read',
    );
    assert.deepEqual(fetchStub.calls, [DESCRIPTION_URL], 'one GET, no search');
  } finally {
    fetchStub.restore();
  }
});

test('an unreachable sonos host resolves to null so the SSDP fallback still runs', async () => {
  const fetchStub = stubFetch(() => ({ ok: false }));
  try {
    assert.equal(await resolveSonosEndpointsByHost(HOST), null);
  } finally {
    fetchStub.restore();
  }
});

test('a configured sonos host resolves its endpoints without SSDP', async () => {
  const fetchStub = stubFetch(describeOnly);
  try {
    const output = new SonosOutput(
      18,
      'Wohnzimmer',
      { host: HOST },
      { sonosGroup: { register: () => undefined, unregister: () => undefined } } as any,
    ) as any;

    assert.equal(await output.ensureEndpoints(), true, 'discovery must not be required');
    assert.equal(output.controlUrl, `http://${HOST}:1400/MediaRenderer/AVTransport/Control`);
    assert.equal(
      output.renderingControlUrl,
      `http://${HOST}:1400/MediaRenderer/RenderingControl/Control`,
    );
    assert.ok(
      fetchStub.calls.includes(DESCRIPTION_URL),
      'the description the zone config already points at must be read directly',
    );
  } finally {
    fetchStub.restore();
  }
});
