import type { ApiHandlerDeps } from '@/adapters/http/api/apiHandler';
import { setOutputDelayMs } from '@/adapters/http/outputDelay';
import { buildPublicAudioServersList } from '@/adapters/discovery/audioServersList';
import { AboutService } from '@/adapters/http/api/aboutService';
import { BrowseService } from '@/adapters/http/api/browseService';
import { DestinationService } from '@/adapters/http/api/destinationService';
import { encodeContainerRef, resolveUriFromRef } from '@/domain/media/browseRef';
import { toApiQueue } from '@/adapters/http/api/queueProjection';
import { toApiFavorites, toApiRecents } from '@/adapters/http/api/libraryProjection';
import { toApiInput } from '@/adapters/http/api/inputProjection';
import { getZoneEqualizerBands } from '@/domain/zones/equalizer';
import { resizeCoverUrl, resizeTuneInCoverUrl } from '@/shared/coverArt';
import type { ApiEventHub } from '@/adapters/http/api/apiEventHub';
import type { ApiGroupResult, ApiOutput, ApiPlaylist, ApiPowerState, ApiAudioFormat, ApiVolumeLimits, ApiZoneSession } from '@/domain/zones/apiTypes';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { AudioAnalysisService } from '@/application/audio/audioAnalysisService';
import type { AudioAnalysisEvent, AudioAnalysisSubscription } from '@/application/audio/audioAnalysisService';
import type { ApiOutputCapabilities } from '@/domain/zones/apiTypes';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import type { GroupManagerReadPort, GroupManagerWritePort } from '@/application/groups/groupManager';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { AlertsPort } from '@/ports/AlertsPort';
import type { LineInActivationService } from '@/application/inputs/lineInActivationService';
import type { AudioManager } from '@/application/playback/audioManager';
import type { SonnCorePeerRegistry } from '@/adapters/discovery/sonnCorePeerRegistry';
import type { ServerLifecycle } from '@/domain/server/lifecycle';
import { buildHealthReport } from '@/adapters/http/api/healthReport';

/**
 * The Loxone link as a health signal, or null when Loxone is not part of this install.
 *
 * A server nobody ever pointed a Miniserver at should not report a Loxone check at all —
 * an absent integration is not a degraded one.
 */
function loxoneHealthInputs(
  audioserver: { paired?: boolean; loxoneEnabled?: boolean } | undefined,
): { enabled: boolean; paired: boolean } | null {
  const enabled = audioserver?.loxoneEnabled === true;
  const paired = audioserver?.paired === true;
  return enabled || paired ? { enabled, paired } : null;
}

/**
 * Hosts the public HTTP gateway (admin UI, API stub, music streaming, Sendspin).
 */

/** A local playlist as the API publishes it: a browse ref for an id, and the counts. */
function toApiPlaylist(playlist: {
  id: string;
  name: string;
  tracks: number;
  audiopath: string;
  coverurl?: string;
}): ApiPlaylist {
  return {
    id: encodeContainerRef({
      kind: 'playlist',
      service: 'library',
      folderId: playlist.audiopath,
    }),
    name: playlist.name,
    tracks: playlist.tracks,
    ...(playlist.coverurl ? { coverUrl: playlist.coverurl } : {}),
  };
}

/**
 * The zone operations the public API can perform: fourteen of the facade's thirty-seven members.
 *
 * `ZoneManagerFacade` is a `Pick` of thirty-seven methods, so every consumer that wanted two of
 * them saw all thirty-seven — including this one, which is the surface reachable from the network.
 * Narrowing it here makes the answer to "what can /api/v1 do to a zone?" a type rather than an
 * audit, and a new capability has to be added deliberately instead of arriving for free.
 */
export type ApiZoneOperations = Pick<
  ZoneManagerFacade,
  | 'getAllZoneStates'
  | 'getZoneState'
  | 'getRawQueue'
  | 'getGroupMembership'
  | 'getOutputCapabilities'
  | 'getOutputSyncStatus'
  | 'handleCommand'
  | 'handoff'
  | 'playContent'
  | 'setPower'
  | 'powerOffImmediately'
  | 'setEqualizerBands'
  | 'setOutputLatency'
  | 'queue'
>;

/**
 * Everything the public API needs, and nothing else.
 *
 * `ApiHandler` takes 88 dependencies; this is where they are built. It used to be built inside
 * `HttpService`, which meant 286 of that class's 444 constructor lines were this one literal and
 * nothing said which of its 53 options the API surface actually used. Twenty-two of them, it
 * turns out — so that is what this file asks for.
 *
 * Only the wiring moved. Every lambda below is the one that was there.
 */
export type ApiSurfaceDeps = {
  zoneManager: ApiZoneOperations;
  audioAnalysis: AudioAnalysisService;
  configPort: ConfigPort;
  contentManager: ContentManager;
  audioManager: AudioManager;
  lineInActivationService: LineInActivationService;
  recentsManager: RecentsManager;
  favoritesManager: FavoritesManager;
  groupManager: GroupManagerReadPort & GroupManagerWritePort;
  sonnCorePeers: SonnCorePeerRegistry;
  /** Plays announcements into zones; see ApiHandlerDeps.playAlert. */
  alerts: AlertsPort;
  apiEventHub: ApiEventHub;
  /** Resolves which device a zone's output plays to; see ApiOutput.device. */
  resolveOutputDevice: (zoneId: number) => ApiOutput['device'] | undefined;
  /** Resolves a zone's volume cap, power-on level and step. */
  resolveVolumeLimits: (zoneId: number) => ApiVolumeLimits | undefined;
  /** Resolves the last confirmed and desired physical power state. */
  resolvePowerState: (zoneId: number) => ApiPowerState | null;
  /** Resolves which protocol a zone plays over; see ApiOutput. */
  resolveOutputProtocol: (zoneId: number) => string | null;
  waveforms: { get: (audiopath: string) => { buckets: number[]; durationMs: number | null } | null };
  /** Resolves the configured name of the service an audiopath belongs to. */
  resolveServiceLabel: (audiopath: string) => string | null;
  /** Names a configured line-in for `source.name`; see InputLabelLookup. */
  resolveInputLabel: (inputId: string) => string | null;
  /** What a zone is streaming, for `format`; see toApiAudioFormat. */
  resolveStreamFormat: (zoneId: number) => ApiAudioFormat | null;
  /** This run of playback's counters, for `session`; see ZoneSessionStats. */
  resolveZoneSession: (zoneId: number) => ApiZoneSession | null;
  serverVersion: string;
  /** Whether the server is serving yet, for /health and /ready. */
  lifecycle: ServerLifecycle;
};

/**
 * The three services the API surface owns rather than receives.
 *
 * They are constructed alongside it and read by its lambdas, so they are passed in separately:
 * a dependency this surface creates is not a dependency the caller has to know about.
 */
export type ApiSurfaceServices = {
  browse: BrowseService;
  about: AboutService;
  destinations: DestinationService;
};

export function createApiHandlerDeps(
  deps: ApiSurfaceDeps,
  services: ApiSurfaceServices,
): ApiHandlerDeps {
  return {
    eventHub: deps.apiEventHub,
    getAllZoneStates: () => deps.zoneManager.getAllZoneStates(),
    getZoneState: (zoneId) => deps.zoneManager.getZoneState(zoneId),
    handleCommand: (zoneId, command, payload) =>
      deps.zoneManager.handleCommand(zoneId, command, payload),
    setPower: (zoneId, signal) => deps.zoneManager.setPower(zoneId, signal),
    powerOffImmediately: (zoneId) => deps.zoneManager.powerOffImmediately(zoneId),
    getOutputCapabilities: (zoneId) =>
      deps.zoneManager.getOutputCapabilities(zoneId) as ApiOutputCapabilities | null,
    getOutputSync: (zoneId) => deps.zoneManager.getOutputSyncStatus(zoneId),
    getWaveform: (audiopath) => deps.waveforms.get(audiopath),
    getGroup: (zoneId) => deps.zoneManager.getGroupMembership(zoneId),
    // The same setter the admin route uses, so both transports write the config identically.
    setOutputDelay: (zoneId, delayMs, clientId) =>
      setOutputDelayMs(
        {
          configPort: deps.configPort,
          setOutputLatency: (id, ms, target) =>
            deps.zoneManager.setOutputLatency(id, ms, target),
        },
        zoneId,
        delayMs,
        clientId,
      ),
    getAudioAnalysisFormat: (zoneId) => {
      const output = deps.resolveStreamFormat(zoneId)?.output;
      return output
        ? { sampleRate: output.sampleRate, channels: output.channels, bitDepth: output.bitDepth ?? 16 }
        : null;
    },
    subscribeAudioAnalysis: (
      zoneId: number,
      analysisOptions: AudioAnalysisSubscription,
      listener: (event: AudioAnalysisEvent) => void,
    ) => deps.audioAnalysis.subscribe(zoneId, analysisOptions, listener),
    resetAudioAnalysis: (zoneId: number) => deps.audioAnalysis.reset(zoneId),
    // 'api' as the type, so anything keying on how playback started can tell this
    // apart from a Loxone tap or a favourite.
    // Accepts a browse id as well as a raw audiopath: browse hands out ids, and the guide
    // promises they round-trip into play.
    playContent: (zoneId, uri) =>
      deps.zoneManager.playContent(zoneId, resolveUriFromRef(uri), 'api'),
    getOutputDevice: (zoneId) => deps.resolveOutputDevice(zoneId),
    getVolumeLimits: (zoneId) => deps.resolveVolumeLimits(zoneId),
    getPowerState: (zoneId) => deps.resolvePowerState(zoneId),
    getOutputProtocol: (zoneId) => deps.resolveOutputProtocol(zoneId),
    getHealth: () =>
      buildHealthReport({
        lifecycle: deps.lifecycle.snapshot(),
        version: deps.serverVersion,
        zones: deps.zoneManager.getAllZoneStates().map((state) => {
          // A zone has one session but a session can encode several profiles, so fold
          // them into the worst case: any profile failing means this zone is failing.
          const stats = deps.audioManager.getStreamStats(state.id);
          return {
            id: state.id,
            name: state.name,
            restarts: stats.reduce((worst, entry) => Math.max(worst, entry.restarts), 0),
            lastError: stats.find((entry) => entry.lastError)?.lastError ?? null,
          };
        }),
        loxone: loxoneHealthInputs(deps.configPort.getConfig()?.system?.audioserver),
      }),
    getLifecycle: () => deps.lifecycle.snapshot(),
    listDestinations: (clientId) => services.destinations.list(clientId),
    getLocalDestinationOwner: (zoneId) => services.destinations.ownerOf(zoneId),
    registerLocalDestination: (opts) => services.destinations.registerLocal(opts),
    removeLocalDestination: (id) => services.destinations.removeLocal(id),
    listServices: () => services.browse.listServices(),
    browse: (id, start, limit) => services.browse.browse(id, start, limit),
    describeItem: (id) => services.browse.describeItem(id),
    describeAbout: (id) => services.about.describeAbout(id),
    search: (request) => services.browse.search(request),
    listPlaylists: async (start, limit) => {
      const page = await deps.contentManager.listLocalPlaylists(start, limit);
      return { items: page.items.map(toApiPlaylist), total: page.total };
    },
    createPlaylist: async (name) => toApiPlaylist(deps.contentManager.createLocalPlaylist(name)),
    renamePlaylist: async (id, name) => {
      const playlist = deps.contentManager.renameLocalPlaylist(Number(id), name);
      return playlist ? toApiPlaylist(playlist) : null;
    },
    deletePlaylist: async (id) => deps.contentManager.deleteLocalPlaylist(Number(id)),
    addPlaylistItem: async (id, itemId) =>
      (await deps.contentManager.addItemsToLocalPlaylist(Number(id), resolveUriFromRef(itemId))) > 0,
    removePlaylistItem: async (id, position) =>
      deps.contentManager.removeLocalPlaylistItem(Number(id), position),
    movePlaylistItem: async (id, from, to) =>
      deps.contentManager.moveLocalPlaylistItem(Number(id), from, to),
    getInputs: () => {
      // listLineInInputs resolves ids/names/icons; controllable and metadataEnabled are
      // config flags it does not carry, so they are joined back on by id here.
      const configured = deps.configPort.getConfig()?.inputs?.lineIn?.inputs ?? [];
      return deps.lineInActivationService.listLineInInputs().map((input) => {
        const record = configured.find(
          (entry) => typeof entry?.id === 'string' && entry.id.trim() === input.id,
        );
        return toApiInput({
          id: input.id,
          name: input.name,
          iconType: input.iconType,
          controllable: record?.controllable,
          metadataEnabled: record?.metadataEnabled,
        });
      });
    },
    selectInput: (zoneId, inputId) => {
      const input = deps.lineInActivationService.findLineInInput(inputId);
      if (!input) {
        return false;
      }
      // Pass the resolved name and icon: the service would otherwise look them up again,
      // and its no-signal fallback is aimed at the Loxone client rather than at us.
      deps.lineInActivationService.activateLineIn(zoneId, inputId, {
        title: input.name,
        iconType: input.iconType,
      });
      return true;
    },
    playAlert: async (request) => {
      if (!deps.zoneManager.getZoneState(request.zoneId)) {
        return null;
      }
      // handleGroupedAlert covers the single-zone case too: it takes the leader plus the
      // full target list, and one zone is simply a group of one.
      return deps.alerts.handleGroupedAlert(
        request.zoneId,
        request.type,
        request.action,
        request.zones,
        request.text,
        request.language,
        request.volume,
      );
    },
    getZoneCover: (zoneId, targetSize) => {
      const session = deps.audioManager.getSession(zoneId);
      // Inline bytes win: embedded artwork has no url to hand out.
      if (session?.cover) {
        return session.cover;
      }
      const state = deps.zoneManager.getZoneState(zoneId);
      const source = state?.coverurl?.trim() || '';
      if (!source) {
        return null;
      }
      // Ask the provider for the requested size where it supports variants; otherwise
      // this returns the url unchanged.
      const sized = resizeCoverUrl(source, targetSize);
      return source.includes('tunein.com') ? resizeTuneInCoverUrl(sized, targetSize) : sized;
    },
    getQueue: (zoneId, start, limit) => {
      if (!deps.zoneManager.getZoneState(zoneId)) {
        return null;
      }
      return toApiQueue(zoneId, deps.zoneManager.getRawQueue(zoneId, start, limit));
    },
    queueAppend: async (zoneId, uri) => {
      await deps.zoneManager.queue.appendUri(zoneId, resolveUriFromRef(uri));
    },
    queueInsertNext: async (zoneId, uri) => {
      await deps.zoneManager.queue.insertUriAfterCurrent(zoneId, resolveUriFromRef(uri));
    },
    queuePlay: (zoneId, itemId) => {
      if (!deps.zoneManager.queue.seekInQueue(zoneId, itemId)) {
        return false;
      }
      deps.zoneManager.handleCommand(zoneId, 'queueplaycurrent');
      return true;
    },
    queueMove: (zoneId, itemId, beforeId) =>
      deps.zoneManager.queue.moveBeforeUniqueId(zoneId, itemId, beforeId ?? 'end'),
    queueRemove: (zoneId, itemId) => deps.zoneManager.queue.removeByUniqueId(zoneId, itemId),
    queueClear: (zoneId) => deps.zoneManager.queue.clear(zoneId),
    queueUndo: (zoneId) => deps.zoneManager.queue.undo(zoneId),
    handoff: (sourceId, targetId) => deps.zoneManager.handoff(sourceId, targetId),
    listAudioServers: () => buildPublicAudioServersList(deps.configPort, deps.sonnCorePeers),
    getFavorites: async (zoneId, start, limit) => {
      if (!deps.zoneManager.getZoneState(zoneId)) {
        return null;
      }
      return toApiFavorites(
        zoneId,
        await deps.favoritesManager.get(zoneId, start, limit),
        deps.contentManager.getBridgeRegistry(),
      );
    },
    addFavorite: async (zoneId, name, uri) => {
      // A browse row hands out an opaque ref, and the guide promises it works anywhere a
      // `uri` is taken. Store the audiopath it means, exactly as `play` does: an unresolved
      // ref has no metadata to look up and cannot be played back later either.
      const created = await deps.favoritesManager.add(zoneId, name, resolveUriFromRef(uri));
      return {
        id: created.id,
        name: created.name || created.title || '',
        source: created.audiopath ?? '',
        coverUrl: created.coverurl ?? '',
      };
    },
    renameFavorite: async (zoneId, id, name) => {
      await deps.favoritesManager.setName(zoneId, id, name);
    },
    removeFavorite: async (zoneId, id) => {
      await deps.favoritesManager.remove(zoneId, id);
    },
    reorderFavorites: async (zoneId, ids) => {
      await deps.favoritesManager.reorder(zoneId, ids);
    },
    playFavorite: async (zoneId, id) => {
      const uri = await deps.favoritesManager.getAudiopathForFavorite(zoneId, id);
      if (!uri) {
        return false;
      }
      // Resolve on the way out too, so favourites stored as a browse ref before that was
      // fixed still play instead of being handed to the queue as gibberish.
      await deps.zoneManager.playContent(zoneId, resolveUriFromRef(uri), 'api');
      return true;
    },
    getRecents: async (zoneId, start, limit) => {
      if (!deps.zoneManager.getZoneState(zoneId)) {
        return null;
      }
      return toApiRecents(
        zoneId,
        await deps.recentsManager.get(zoneId),
        start,
        limit,
        deps.contentManager.getBridgeRegistry(),
        deps.zoneManager.getZoneState(zoneId)?.name ?? '',
      );
    },
    setGroup: (zoneId, members) => {
      if (!deps.zoneManager.getZoneState(zoneId)) {
        return null;
      }
      // Empty list means "leave the group"; there is no separate verb for it.
      if (members.length === 0) {
        deps.groupManager.removeGroup(zoneId);
        return { leader: zoneId, members: [], rejected: [] };
      }
      // Same rule the Loxone path applies: grouping mirrors frames between outputs of
      // one protocol, so a member on another cannot join unless mixed groups are on.
      const mixedAllowed = deps.configPort.getConfig().groups?.mixedGroupEnabled === true;
      const protocolOf = (id: number) => deps.resolveOutputProtocol(id);
      const leaderProtocol = protocolOf(zoneId);
      const rejected: ApiGroupResult['rejected'] = [];
      const accepted: number[] = [];
      for (const id of members) {
        if (id === zoneId) continue;
        if (!deps.zoneManager.getZoneState(id)) {
          rejected.push({ id, reason: 'zone-not-found' });
          continue;
        }
        if (!mixedAllowed && protocolOf(id) !== leaderProtocol) {
          rejected.push({ id, reason: 'protocol-mismatch' });
          continue;
        }
        accepted.push(id);
      }
      const finalMembers = [zoneId, ...accepted];
      deps.groupManager.upsert({
        leader: zoneId,
        members: finalMembers,
        backend: 'Unknown',
        source: 'manual',
        externalId: `group-${zoneId}`,
      });
      return { leader: zoneId, members: finalMembers, rejected };
    },
    clearRecents: async (zoneId) => {
      await deps.recentsManager.clear(zoneId);
    },
    getServiceLabel: (audiopath) => deps.resolveServiceLabel(audiopath),
    getInputLabel: (inputId) => deps.resolveInputLabel(inputId),
    getStreamFormat: (zoneId) => deps.resolveStreamFormat(zoneId),
    getZoneSession: (zoneId) => deps.resolveZoneSession(zoneId),
    getEqualizerBands: (zoneId) => {
      const zone = deps.configPort.getConfig().zones?.find((z) => z.id === zoneId);
      return zone ? [...getZoneEqualizerBands(zone)] : null;
    },
    setEqualizerBands: async (zoneId, bands) => {
      const updated = await deps.zoneManager.setEqualizerBands(zoneId, bands);
      return updated ? [...updated.bands] : null;
    },
    serverVersion: deps.serverVersion,
    startedAt: Date.now(),
  };
}
