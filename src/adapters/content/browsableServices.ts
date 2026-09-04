import type { ConfigPort } from '@/ports/ConfigPort';
import type { BrowsableService, ContentFolder, ContentFolderItem } from '@/ports/ContentTypes';
import { capabilitiesFor } from '@/adapters/content/providerCapabilities';
import { providerTitle } from '@/adapters/content/providerRegistry';
import {
  searchSourceFromServiceKey,
  serviceNativeKey,
} from '@/domain/media/serviceIdentity';



/**
 * What the catalogue needs from the content layer to bind each service's `browse`.
 *
 * Four methods, named structurally rather than as `ContentManager`: two of them are not on
 * `ContentPort`, and a builder that takes the whole manager cannot be read without knowing what
 * it might reach for.
 */
export type BrowsableServiceBackend = {
  getMediaFolder: (folderId: string, offset: number, limit: number) => Promise<ContentFolder | null>;
  getRadioFolder: (folderId: string, offset: number, limit: number) => Promise<ContentFolder | null>;
  getServiceFolder: (
    service: string,
    user: string,
    folderId: string,
    offset: number,
    limit: number,
  ) => Promise<ContentFolder | null>;
  getRelatedArtists: (
    service: string,
    user: string,
    folderId: string,
    limit: number,
  ) => Promise<ContentFolderItem[]>;
};

/**
 * Normalise a configured provider allowlist. `null` means "no restriction" —
 * an empty array is treated the same, so an accidentally-empty list does not
 * silently hide everything.
 */
export function parseProviderAllowlist(providers?: string[] | null): Set<string> | null {
  if (!providers || providers.length === 0) {
    return null;
  }
  const allow = new Set(providers.map((p) => String(p).trim().toLowerCase()).filter(Boolean));
  return allow.size > 0 ? allow : null;
}

/**
 * Build the catalogue of browsable services from config: the local library, the
 * built-in radio tile, and one entry per enabled streaming bridge (so multiple
 * accounts of the same provider each get their own service).
 *
 * Called per request by its consumers so config changes take effect without a
 * restart.
 */
export function buildBrowsableServices(
  config: ConfigPort,
  backend: BrowsableServiceBackend,
  allow: Set<string> | null = null,
): BrowsableService[] {
  const permitted = (provider: string): boolean => !allow || allow.has(provider);
  const services: BrowsableService[] = [];

  if (permitted('library')) {
    services.push({
      key: 'library',
      provider: 'library',
      title: providerTitle('library'),
      rootFolderId: 'root',
      // The library root lists storages; the collection categories live under
      // each storage folder. Both local and NAS storage expose albums, artists
      // and tracks; Local Media also exposes the user-managed playlists.
      id3Probe: 'library-local',
      searchSource: 'local',
      capabilities: capabilitiesFor('library'),
      browse: (folderId, offset, limit) => backend.getMediaFolder(folderId, offset, limit),
    });
  }

  // One Radio root contains Radio Paradise, TuneIn presets and custom streams. Keep the
  // grouping here so clients do not need to know that these are backed by different providers.
  if (permitted('radio')) {
    services.push({
      key: 'radio',
      provider: 'radio',
      title: providerTitle('radio'),
      rootFolderId: 'start',
      id3Probe: 'start',
      // Radio is a stream directory, not a searchable track catalogue.
      searchSource: null,
      // Radio is browsable but its providers do not answer a general search.
      capabilities: capabilitiesFor('radio'),
      browse: (folderId, offset, limit) => backend.getRadioFolder(folderId, offset, limit),
    });
  }

  // Spotify is the one service whose accounts do not live in
  // `content.streamingServices`: they carry their own credentials and predate that neutral
  // surface, so they sit in `content.spotify.accounts`. To a non-Loxone consumer a Spotify
  // account is a service like any other, and reading only the bridge list meant an added
  // account appeared in the Loxone app — which asks `listServiceEntries()`, and that does read
  // the accounts — while `/api/v1/services`, DLNA and Subsonic never heard of it.
  if (permitted('spotify')) {
    const accounts = (config.getConfig().content?.spotify?.accounts ?? []).filter(
      (account) => account && (account.id?.trim() || account.user?.trim()),
    );
    for (const account of accounts) {
      const accountId = (account.id?.trim() || account.user?.trim())!;
      // Same rule as `serviceNativeKey`: the bare service name while there is one of it, and
      // the account appended once a second one makes the name ambiguous.
      const key = accounts.length > 1 ? `spotify:${accountId}` : 'spotify';
      const label =
        account.displayName?.trim() || account.name?.trim() || account.user?.trim() || accountId;
      services.push({
        key,
        provider: 'spotify',
        title: accounts.length > 1 ? `${providerTitle('spotify')} — ${label}` : providerTitle('spotify'),
        rootFolderId: 'root',
        id3Probe: 'root',
        // Named down to the account, unlike the bridge services above: the internal provider
        // map is keyed `spotify@<accountId>`, so a bare `spotify` source matches nothing and
        // the search would silently answer empty.
        searchSource: `spotify@${accountId}`,
        capabilities: capabilitiesFor('spotify'),
        // The account goes in the `user` slot for the same reason — with several providers
        // configured the manager refuses to guess rather than serve another account's library.
        browse: (folderId, offset, limit) =>
          backend.getServiceFolder('spotify', accountId, folderId, offset, limit),
        relatedArtists: (folderId, limit) =>
          backend.getRelatedArtists('spotify', accountId, folderId, limit),
      });
    }
  }

  const bridges = config.getConfig().content.streamingServices ?? [];
  for (const bridge of bridges) {
    if (!bridge || bridge.enabled === false || !bridge.id) {
      continue;
    }
    const provider = bridge.provider?.trim().toLowerCase();
    if (!provider || !permitted(provider)) {
      continue;
    }
    // These consumers have no Spotify to be disguised as, so the account is named
    // service-natively here — `applemusic`, or `applemusic:p0gngd` when there is
    // more than one of that service. The Loxone bridge id never leaves its adapter.
    const key = serviceNativeKey(bridge, bridges);
    services.push({
      key,
      provider,
      title: bridge.label?.trim() || providerTitle(provider),
      rootFolderId: 'root',
      id3Probe: 'root',
      searchSource: searchSourceFromServiceKey(key),
      capabilities: capabilitiesFor(provider),
      browse: (folderId, offset, limit) =>
        backend.getServiceFolder(key, key, folderId, offset, limit),
      relatedArtists: (folderId, limit) => backend.getRelatedArtists(key, key, folderId, limit),
    });
  }

  return services;
}
