import type { RadioAdminPort } from '../../src/ports/RadioAdminPort';

/**
 * A radio admin surface that answers without reaching anything.
 *
 * The real one talks to a community-run index over the internet and spawns a decoder on a
 * stream url. Override only what a test cares about; the rest reports the honest "found
 * nothing, played nothing" shape.
 */
export function makeRadioAdminFake(overrides: Partial<RadioAdminPort> = {}): RadioAdminPort {
  return {
    searchStations: async () => [],
    reportStationPicked: async () => {},
    openPreview: async () => ({ ok: false, error: 'preview-unplayable', detail: 'not in this test' }),
    ...overrides,
  };
}
