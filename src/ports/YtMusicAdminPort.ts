/**
 * Administering the YouTube stack: the YT Music cookie, the PO Token plumbing and yt-dlp.
 *
 * One port for three modules because it is one toolchain — the same yt-dlp binary serves both
 * YouTube providers, and the PO Token plugin is installed into it. Three admin screens used to
 * import those modules directly, which is why none of them could be tested: their operations
 * ping a local server, run pip, and download a binary over the network.
 *
 * Everything here is a *management* operation. Nothing on this port is used to play anything.
 */
/**
 * What the configured YouTube Music cookie is currently worth.
 *
 * `expired` is the state this file exists for. YouTube rotates account cookies on
 * open browser tabs as a security measure, so a cookie copied out of a live session
 * stops identifying anyone within the hour — and it stops silently, answering 200
 * with a sign-in prompt. Before this, that turned into a `log.warn` and an empty
 * library, which is exactly what "my library is gone" looked like from the outside
 * with nothing telling anyone to paste a new cookie.
 */
export type YtMusicAuthState = 'ok' | 'expired' | 'invalid' | 'missing' | 'unknown';

export type YtMusicAuthStatus = {
  state: YtMusicAuthState;
  /** When this was last established, or null when never checked. */
  checkedAt: number | null;
  /** Detail worth showing a user, when there is any. */
  message: string | null;
};

export type PotServerPing = {
  ok: boolean;
  /** Version the server reports, when it answered with one. */
  version: string | null;
  /** Why the ping failed, for the setup screen to show verbatim. */
  error: string | null;
};

export type PotPluginStatus = {
  /** Version installed here, or null when the plugin is absent. */
  installed: string | null;
  /** Newest published release, when the feed could be reached. */
  latest: string | null;
  /** Null when `latest` is unknown, so "unknown" never reads as "up to date". */
  updateAvailable: boolean | null;
};

export type PotPluginInstallResult =
  | { ok: true; version: string; previous: string | null }
  | { ok: false; error: string };

export type YtDlpStatus = {
  /** Version actually in use, or null when no yt-dlp can be run at all. */
  version: string | null;
  /** Path of the binary that would run now. */
  source: string;
  /** True when that path is the managed copy rather than the one from the image. */
  managed: boolean;
  /** Newest published release, when it could be looked up. */
  latest: string | null;
  /** Null when `latest` is unknown, so "unknown" never renders as "up to date". */
  updateAvailable: boolean | null;
};

export type YtDlpUpdateResult =
  | { ok: true; version: string; previous: string | null }
  | { ok: false; error: string };

export interface YtMusicAdminPort {
  /** Where a fresh install should look for a PO Token server, for the setup screen to prefill. */
  readonly defaultPotServerUrl: string;
  /** Normalises a configured PO Token server URL; empty when there is nothing usable. */
  normalizePotServerUrl(raw: unknown): string;
  /** What the stored cookie for this bridge is currently worth, without asking YouTube. */
  authStatus(bridgeId: string): YtMusicAuthStatus;
  /** Asks YouTube whether a cookie still identifies anyone. */
  verifyCookie(cookie: string): Promise<YtMusicAuthStatus>;
  pingPotServer(rawUrl: string, options?: { force?: boolean }): Promise<PotServerPing>;
  potPluginStatus(): Promise<PotPluginStatus>;
  installPotPlugin(): Promise<PotPluginInstallResult>;
  ytDlpStatus(): Promise<YtDlpStatus>;
  updateYtDlp(): Promise<YtDlpUpdateResult>;
}
