import type { YtMusicAdminPort } from '../../src/ports/YtMusicAdminPort';

/**
 * A YouTube stack that answers without touching anything.
 *
 * The real one pings a local PO Token server, runs pip and downloads a yt-dlp release, which is
 * why the three admin screens built on it had no tests at all. Override only what a test cares
 * about; the rest reports the honest "nothing installed, nothing known" shape.
 */
export function makeYtMusicAdminFake(
  overrides: Partial<YtMusicAdminPort> = {},
): YtMusicAdminPort {
  return {
    defaultPotServerUrl: 'http://127.0.0.1:4416',
    normalizePotServerUrl: (raw) => (typeof raw === 'string' ? raw.trim() : ''),
    authStatus: () => ({ state: 'missing', checkedAt: null, message: null }),
    verifyCookie: async () => ({ state: 'ok', checkedAt: 1, message: null }),
    pingPotServer: async () => ({ ok: false, version: null, error: 'not reachable' }),
    potPluginStatus: async () => ({ installed: null, latest: null, updateAvailable: null }),
    installPotPlugin: async () => ({ ok: false, error: 'not in this test' }),
    ytDlpStatus: async () => ({
      version: null,
      source: '/usr/bin/yt-dlp',
      managed: false,
      latest: null,
      updateAvailable: null,
    }),
    updateYtDlp: async () => ({ ok: false, error: 'not in this test' }),
    ...overrides,
  };
}
