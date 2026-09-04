import {
  getYtMusicAuthStatus,
  verifyYtMusicCookie,
} from '@/adapters/content/providers/ytmusic/ytmusicAuthState';
import {
  DEFAULT_PO_TOKEN_SERVER_URL,
  normalizePotServerUrl,
  pingPotServer,
} from '@/adapters/content/providers/ytmusic/ytmusicPoToken';
import {
  getPotPluginStatus,
  installPotPlugin,
} from '@/adapters/content/providers/ytmusic/ytdlpPotProvider';
import { getYtDlpStatus, updateYtDlp } from '@/adapters/content/providers/ytmusic/ytdlpBinary';
import type { YtMusicAdminPort } from '@/ports/YtMusicAdminPort';

/**
 * The YouTube stack's management operations, gathered where they are implemented.
 *
 * Nothing but delegation, on purpose: the work stays in the module that owns the tool. What this
 * buys is that the three admin screens hold one injected object instead of importing six
 * functions from four modules, and can be handed a fake that neither pings nor downloads.
 */
export const ytMusicAdmin: YtMusicAdminPort = {
  defaultPotServerUrl: DEFAULT_PO_TOKEN_SERVER_URL,
  normalizePotServerUrl: (raw) => normalizePotServerUrl(raw),
  authStatus: (bridgeId) => getYtMusicAuthStatus(bridgeId),
  verifyCookie: (cookie) => verifyYtMusicCookie(cookie),
  pingPotServer: (rawUrl, options) => pingPotServer(rawUrl, options),
  potPluginStatus: () => getPotPluginStatus(),
  installPotPlugin: () => installPotPlugin(),
  ytDlpStatus: () => getYtDlpStatus(),
  updateYtDlp: () => updateYtDlp(),
};
