import { discoverAirplayDevices } from '@/adapters/outputs/airplay/airplayDiscovery';
import { discoverDlnaDevices } from '@/adapters/outputs/dlna/dlnaDiscovery';
import { discoverGoogleCastDevices } from '@/adapters/outputs/googleCast/googleCastDiscovery';
import { discoverSonosDevices } from '@/adapters/outputs/sonos/sonosDiscovery';
import { OUTPUT_DEFINITIONS } from '@/adapters/outputs/factory';
import type { OutputDiscoveryPort } from '@/ports/OutputDiscoveryPort';

/**
 * The one place that knows which output families can be searched for.
 *
 * Deliberately nothing but delegation: the protocol work stays with the family that speaks it.
 * What this buys is that a caller holds one injected object instead of importing four modules,
 * so adding a fifth protocol is a change here and in the factory rather than in the admin routes.
 */
export const outputDiscovery: OutputDiscoveryPort = {
  definitions: OUTPUT_DEFINITIONS,
  airplay: (timeoutMs) => discoverAirplayDevices(timeoutMs),
  googleCast: (timeoutMs, explicitHosts) => discoverGoogleCastDevices(timeoutMs, explicitHosts),
  dlna: (options) => discoverDlnaDevices(options),
  sonos: (options) => discoverSonosDevices(options),
};
