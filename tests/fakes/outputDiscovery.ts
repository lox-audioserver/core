import type { OutputDiscoveryPort } from '../../src/ports/OutputDiscoveryPort';

/**
 * Discovery that finds nothing and touches no network.
 *
 * The admin device-scan routes used to import the four output families directly, which meant a
 * test of them waited on real mDNS and SSDP answers. Pass this instead and record what was asked.
 */
export function makeOutputDiscoveryFake(
  overrides: Partial<OutputDiscoveryPort> = {},
): OutputDiscoveryPort {
  return {
    definitions: [],
    airplay: async () => [],
    googleCast: async () => [],
    dlna: async () => [],
    sonos: async () => [],
    ...overrides,
  };
}
