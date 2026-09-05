import type { SoloistAdminPort } from '../../src/ports/SoloistAdminPort';

/**
 * A Soloist install that is simply absent.
 *
 * The real one probes a binary on disk, unpacks a gzipped release and opens a pairing window
 * that waits on a Spotify app to answer — which is why the setup routes had no tests. Override
 * only what a test is about; the default reports the state of a server nobody has set up yet.
 */
export function makeSoloistAdminFake(overrides: Partial<SoloistAdminPort> = {}): SoloistAdminPort {
  return {
    binaryStatus: async () => ({ present: false, executable: false }),
    binaryPath: () => '/data/bin/soloist',
    looksGzipped: () => false,
    extractFromArchive: () => null,
    autoUpdateUrl: () => null,
    pairingSnapshot: () => null,
    startPairing: async () => ({ state: 'pairing', deviceName: 'Test' }),
    cancelPairing: () => {},
    ...overrides,
  };
}
