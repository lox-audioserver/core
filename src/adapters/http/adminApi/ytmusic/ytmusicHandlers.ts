import type { YtMusicAdminPort } from '@/ports/YtMusicAdminPort';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { Route } from '@/adapters/http/adminApi/routeTypes';

export type YtMusicHandlerDeps = {
  log: ComponentLogger;
  /**
   * The YouTube stack's management operations; see YtMusicAdminPort.
   *
   * Injected rather than imported: these ping a local server, run pip and download a binary, so
   * a route that reaches for them directly cannot be exercised at all.
   */
  ytMusicAdmin: YtMusicAdminPort;

  configPort: ConfigPort;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

/**
 * What the YouTube Music setup screen needs to tell a user why nothing is playing.
 *
 * Two answers live here, both of which the server used to keep to itself: whether
 * the pasted cookie still identifies anyone (it expires within the hour, silently),
 * and whether the PO Token plumbing that a Premium stream needs is actually in place.
 */
export function buildYtMusicRoutes(deps: YtMusicHandlerDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/ytmusic\/status$/,
      handler: async (_req, res) => handleStatus(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/ytmusic\/check$/,
      handler: async (req, res) => handleCheck(req, res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/ytmusic\/pot-plugin\/install$/,
      handler: async (_req, res) => handlePotPluginInstall(res, deps),
    },
  ];
}

async function handleStatus(res: ServerResponse, deps: YtMusicHandlerDeps): Promise<void> {
  try {
    const bridges = (deps.configPort.getConfig().content?.streamingServices ?? []).filter(
      (b) => (b.provider || '').toLowerCase() === 'ytmusic',
    );
    const potPlugin = await deps.ytMusicAdmin.potPluginStatus();
    const rows = await Promise.all(
      bridges.map(async (bridge) => {
        const potUrl = deps.ytMusicAdmin.normalizePotServerUrl(bridge.ytmusicPoTokenUrl);
        return {
          id: bridge.id,
          label: bridge.label ?? bridge.id,
          hasCookie: Boolean(bridge.ytmusicCookie?.trim()),
          // The state observed while serving requests, not a fresh probe: this is a
          // status read, and asking YouTube on every poll would be its own problem.
          cookie: deps.ytMusicAdmin.authStatus(bridge.id),
          potTokenUrl: potUrl || null,
          potServer: potUrl ? await deps.ytMusicAdmin.pingPotServer(potUrl) : null,
        };
      }),
    );
    deps.sendJson(res, 200, { defaultPotTokenUrl: deps.ytMusicAdmin.defaultPotServerUrl, potPlugin, bridges: rows });
  } catch (err) {
    deps.log.warn('ytmusic status failed', { err });
    deps.sendJson(res, 500, { error: 'ytmusic-status-failed' });
  }
}

/**
 * Check what the setup form currently holds, before it is saved.
 *
 * Takes the cookie from the body rather than from config on purpose: the moment
 * worth catching an already-dead cookie is while the user still has the field open.
 */
async function handleCheck(
  req: IncomingMessage,
  res: ServerResponse,
  deps: YtMusicHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as
    | { cookie?: unknown; ytmusicCookie?: unknown; potTokenUrl?: unknown; bridgeId?: unknown }
    | null;
  if (res.writableEnded) return;

  const rawCookie = typeof body?.cookie === 'string'
    ? body.cookie
    : typeof body?.ytmusicCookie === 'string'
      ? body.ytmusicCookie
      : '';
  const bridgeId = typeof body?.bridgeId === 'string' ? body.bridgeId.trim() : '';
  // An empty field on an existing service means "check the one already saved",
  // because the UI never echoes a stored cookie back into the form.
  const cookie = rawCookie.trim() || (bridgeId ? storedCookie(deps, bridgeId) : '');

  const potUrl = deps.ytMusicAdmin.normalizePotServerUrl(body?.potTokenUrl);
  try {
    const [cookieStatus, potPlugin] = await Promise.all([
      deps.ytMusicAdmin.verifyCookie(cookie),
      deps.ytMusicAdmin.potPluginStatus(),
    ]);
    deps.sendJson(res, 200, {
      cookie: cookieStatus,
      potPlugin,
      potServer: potUrl ? await deps.ytMusicAdmin.pingPotServer(potUrl, { force: true }) : null,
    });
  } catch (err) {
    deps.log.warn('ytmusic check failed', { err });
    deps.sendJson(res, 500, { error: 'ytmusic-check-failed' });
  }
}

function storedCookie(deps: YtMusicHandlerDeps, bridgeId: string): string {
  const bridge = (deps.configPort.getConfig().content?.streamingServices ?? []).find(
    (b) => b.id === bridgeId,
  );
  return typeof bridge?.ytmusicCookie === 'string' ? bridge.ytmusicCookie.trim() : '';
}

async function handlePotPluginInstall(res: ServerResponse, deps: YtMusicHandlerDeps): Promise<void> {
  const result = await deps.ytMusicAdmin.installPotPlugin();
  if (!result.ok) {
    // 502: what failed is the reach out to GitHub or the file it sent back.
    deps.sendJson(res, 502, { error: result.error });
    return;
  }
  deps.sendJson(res, 200, { ...(await deps.ytMusicAdmin.potPluginStatus()), previous: result.previous });
}
