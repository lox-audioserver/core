/**
 * Administering the Soloist backend: its binary, and pairing a store to a Spotify account.
 *
 * Soloist is a third-party binary this server manages rather than links against — it expires
 * after ninety days, it is uploaded or downloaded as a gzipped archive, and a store only becomes
 * usable once somebody has picked it in their own Spotify app. All four of those are management
 * operations, and the admin screen used to reach into four modules under `adapters/inputs` to
 * perform them.
 *
 * That made those routes untestable: they probe a binary on disk, unpack an archive and open a
 * pairing window that waits on a real Spotify app to answer.
 */
export type SoloistBinaryStatus = {
  present: boolean;
  executable: boolean;
  version?: string;
  /** Days left before this build stops working, from its own build stamp. Can be negative. */
  expiresInDays?: number;
  /** When it stops working, epoch ms. */
  expiresAt?: number;
  error?: string;
};

export type SoloistPairingState = {
  state: 'idle' | 'pairing' | 'paired' | 'failed';
  deviceName?: string;
  expiresAt?: number;
  /** Whom the store ended up signed in as, as Spotify spells it. */
  username?: string;
  error?: string;
};

export type SoloistPairingRequest = {
  accountId: string;
  apiKey: string;
  deviceName: string;
  /**
   * Who this store is supposed to end up signed in as, when it is known.
   *
   * Nothing stops somebody signing the device in from the wrong Spotify app, and the result plays
   * perfectly — as the wrong account. A store that browses as one person and plays as another is
   * worse than one that is not signed in at all, because nothing about it looks wrong.
   */
  expectedSpotifyId?: string;
  timeoutMs?: number;
};

export interface SoloistAdminPort {
  /** Whether a usable binary is present, and how long this build has left. */
  binaryStatus(): Promise<SoloistBinaryStatus>;
  /** Where a replacement binary is written to. */
  binaryPath(): string;
  /** Whether an uploaded body is a gzipped archive rather than the binary itself. */
  looksGzipped(body: Buffer): boolean;
  /** The Soloist binary out of a release archive, or null when it holds none. */
  extractFromArchive(archive: Buffer): Buffer | null;
  /** The download URL for this host, or null when no build is published for it. */
  autoUpdateUrl(): string | null;
  /** Where an account's pairing stands, without starting one. */
  pairingSnapshot(accountId: string): SoloistPairingState | null;
  startPairing(request: SoloistPairingRequest): Promise<SoloistPairingState>;
  cancelPairing(accountId: string): void;
}
