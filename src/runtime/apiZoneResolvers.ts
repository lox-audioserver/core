import type { ConfigPort } from '@/ports/ConfigPort';
import type { AudioManager } from '@/application/playback/audioManager';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { SqueezeliteCore } from '@/adapters/outputs/squeezelite/squeezeliteCore';
import type {
  InputLabelLookup,
  OutputDeviceLookup,
  OutputProtocolLookup,
  ServiceLabelLookup,
} from '@/adapters/http/api/zoneProjection';
import type { ApiAudioFormat, ApiPowerState, ApiVolumeLimits } from '@/domain/zones/apiTypes';
import { toApiAudioFormat } from '@/adapters/http/api/streamFormat';
import { resolveZoneOutputProtocol } from '@/application/zones/outputProtocol';
import { serviceLabelForAudiopath } from '@/domain/media/serviceIdentity';
import { parseServiceNativeAudiopath } from '@/domain/zones/audiopath';
import { buildSqueezeliteAdminPlayerSnapshot } from '@/adapters/http/adminApi/adminApiHandler';
import { getZoneOutputConfig } from '@/adapters/http/adminApi/config/configHandlers';

/**
 * The parts of a zone the public API reports that `ZoneState` does not hold.
 *
 * Which device it plays to, what its volume will accept, which protocol carries
 * it, what it is streaming: all of it lives in config, in the engine session or
 * in an output adapter. Every one is used twice — once on the request path and
 * once on the event stream — and the whole point is that both answer the same,
 * so a GET and an event never disagree about a zone.
 */
export type ApiZoneResolvers = {
  resolveOutputDevice: OutputDeviceLookup;
  resolveVolumeLimits: (zoneId: number) => ApiVolumeLimits | undefined;
  resolveOutputProtocol: OutputProtocolLookup;
  resolveServiceLabel: ServiceLabelLookup;
  resolveInputLabel: InputLabelLookup;
  resolveStreamFormat: (zoneId: number) => ApiAudioFormat | null;
  resolvePowerState: (zoneId: number) => ApiPowerState | null;
};

/**
 * Collaborators are passed as getters, not values.
 *
 * These resolvers are handed to the notifier taps, which the zone manager, the
 * audio manager and the config port are all built after — the composition root
 * cannot have them yet at the point it needs these. Nothing calls a resolver
 * until a request or an event arrives, by which time everything is wired.
 */
export type ApiZoneResolverDeps = {
  configPort: () => ConfigPort;
  zoneManager: () => ZoneManagerFacade;
  audioManager: () => AudioManager;
  squeezeliteCore: () => SqueezeliteCore;
};

export function createApiZoneResolvers(deps: ApiZoneResolverDeps): ApiZoneResolvers {
  return {
    /**
     * Reuses the squeezelite identity resolver the admin API already had, so the
     * MAC reported here is the one that endpoint reports (sonn-audio/core#247).
     * Only squeezelite identifies a device today; other protocols report none.
     */
    resolveOutputDevice: (zoneId) => {
      const zone = deps.configPort().getConfig().zones?.find((z) => z.id === zoneId);
      if (!zone) {
        return undefined;
      }
      const snapshot = buildSqueezeliteAdminPlayerSnapshot(
        getZoneOutputConfig(zone),
        deps.squeezeliteCore().players,
      );
      return snapshot
        ? { id: snapshot.mac ?? null, name: snapshot.name ?? null, connected: snapshot.connected }
        : undefined;
    },

    resolveVolumeLimits: (zoneId) => {
      const v = deps.configPort().getConfig().zones?.find((z) => z.id === zoneId)?.volumes;
      if (!v) {
        return undefined;
      }
      return { max: v.maxVolume, default: v.default, step: v.volstep };
    },

    /**
     * The Loxone notifier resolves this the same way at emit time; the public API
     * needs it too, since `ZoneState` never stores it.
     */
    resolveOutputProtocol: (zoneId) =>
      resolveZoneOutputProtocol(deps.zoneManager().getTechnicalSnapshot(zoneId)),

    /**
     * The configured name of the service an audiopath belongs to. `state.sourceName`
     * holds the Loxone-facing name instead, which for a bridged service is the
     * Spotify disguise.
     */
    resolveServiceLabel: (audiopath) =>
      serviceLabelForAudiopath(
        audiopath,
        deps.configPort().getConfig().content?.streamingServices,
        parseServiceNativeAudiopath,
      ),

    /**
     * The configured name of a line-in. `state.sourceName` holds the server's MAC
     * for these, which is what the Loxone clients expect and useless to anyone else.
     */
    resolveInputLabel: (inputId) => {
      const inputs = deps.configPort().getConfig()?.inputs?.lineIn?.inputs ?? [];
      const match = inputs.find(
        (entry) => typeof entry?.id === 'string' && entry.id.trim() === inputId,
      );
      const name = typeof match?.name === 'string' ? match.name.trim() : '';
      return name || null;
    },

    /**
     * Read from the engine's session stats, the same source the admin UI's
     * `tech.streamStats` uses.
     */
    resolveStreamFormat: (zoneId) => toApiAudioFormat(deps.audioManager().getStreamStats(zoneId)),

    resolvePowerState: (zoneId) => deps.zoneManager().getPowerState(zoneId),
  };
}
