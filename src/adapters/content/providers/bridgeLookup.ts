import type { StreamingServiceConfig } from '@/domain/config/types';

/**
 * Find the configured account behind a provider key.
 *
 * Every stream service indexes its accounts twice — by service-native key
 * (`deezer`, or `deezer:<slug>` with multiple accounts) and by bridge id — and
 * a request may arrive in either form. Trying both is what makes a legacy
 * `spotify@<bridgeId>:` path and its service-native equivalent reach the same
 * account, so the lookup lives in one place rather than six.
 */
export function findBridgeForProviderKey(
  providerKey: string,
  byProvider: ReadonlyMap<string, StreamingServiceConfig>,
  byId: ReadonlyMap<string, StreamingServiceConfig>,
): StreamingServiceConfig | null {
  return (
    byProvider.get(providerKey) ?? byId.get(providerKey.split('@')[1] ?? '') ?? null
  );
}
