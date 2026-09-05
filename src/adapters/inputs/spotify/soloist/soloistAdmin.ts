import {
  extractSoloistFromArchive,
  looksGzipped,
} from '@/adapters/inputs/spotify/soloist/soloistArchive';
import {
  cancelAccountPairing,
  pairingSnapshot,
  startAccountPairing,
} from '@/adapters/inputs/spotify/soloist/soloistPairing';
import { probeBinary, soloistBinaryPath } from '@/adapters/inputs/spotify/soloist/soloistProcess';
import { buildUrlForHost } from '@/adapters/inputs/spotify/soloist/soloistUpdater';
import type { SoloistAdminPort } from '@/ports/SoloistAdminPort';

/**
 * Soloist's management operations, gathered where they are implemented.
 *
 * Delegation only. The point is that the setup screen holds one injected object rather than
 * importing eight functions from four modules, and can be handed a fake that neither probes a
 * disk nor waits for a Spotify app to answer.
 */
export const soloistAdmin: SoloistAdminPort = {
  binaryStatus: () => probeBinary(),
  binaryPath: () => soloistBinaryPath(),
  looksGzipped: (body) => looksGzipped(body),
  extractFromArchive: (archive) => extractSoloistFromArchive(archive),
  autoUpdateUrl: () => buildUrlForHost(),
  pairingSnapshot: (accountId) => pairingSnapshot(accountId),
  startPairing: (request) => startAccountPairing(request),
  cancelPairing: (accountId) => cancelAccountPairing(accountId),
};
