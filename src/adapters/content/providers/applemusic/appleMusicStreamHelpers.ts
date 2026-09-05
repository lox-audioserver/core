/**
 * The parts of the Apple Music stream path that are only arithmetic and string work.
 *
 * These were private methods on `AppleMusicStreamService`, none of which touched `this`: pure
 * functions that happened to live inside a 1608-line class whose every entry point talks to
 * amp-api, which made them unreachable by a test. For two of them that is worse than untidy —
 * {@link sanitizeProxyHeaders} and {@link buildStreamHeaders} are what keep a listener's Apple
 * Music credentials from being forwarded somewhere they do not belong.
 *
 * Moved verbatim: every body below is the one that was there.
 */
import type { StreamingServiceConfig } from '@/domain/config/types';


export function normalizeSalableAdamId(trackId: string): string {
  const trimmed = trackId.trim();
  const match = trimmed.match(/^[a-z]\.(\d+)$/i);
  if (match && match[1]) {
    return match[1];
  }
  return trimmed;
}

export function extractStreamUrl(info: any): string | null {
  const candidates: Array<string | undefined> = [
    info?.hlsUrl,
    info?.hlsURL,
    info?.streamUrl,
    info?.streamURL,
    info?.url,
    info?.assetUrl,
    info?.assets?.[0]?.url,
    info?.assets?.[0]?.URL,
    info?.assets?.find((asset: any) => typeof asset?.url === 'string')?.url,
    info?.streams?.hls?.url,
    info?.streams?.hls?.[0]?.url,
  ];
  const match = candidates.find((value) => typeof value === 'string' && value.length > 0);
  return match ?? null;
}

export function buildDrmCacheKey(trackId: string, isLibrary: boolean): string {
  return `${isLibrary ? 'library' : 'catalog'}:${trackId}`;
}

export function buildStreamHeaders(headers: Record<string, string>): Record<string, string> | undefined {
  const allowlist = new Set([
    'authorization',
    'media-user-token',
    'music-user-token',
    'user-agent',
    'accept',
    'accept-language',
    'origin',
    'referer',
  ]);
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    if (allowlist.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return Object.keys(filtered).length ? filtered : undefined;
}

export function resolvePaceInput(bridge: StreamingServiceConfig): boolean {
  if (typeof bridge.appleMusicPaceInput === 'boolean') {
    return bridge.appleMusicPaceInput;
  }
  // Default to unpaced input for faster startup; the engine will apply bounded output pacing
  // when needed to avoid running finite sources ahead of wall clock.
  return false;
}

export function sanitizeProxyHeaders(
  targetUrl: string,
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) {
    return headers;
  }
  let host = '';
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    host = '';
  }
  const sanitized = { ...headers };
  delete (sanitized as Record<string, string>).Host;
  delete (sanitized as Record<string, string>).host;
  if (host.endsWith('blobstore.apple.com')) {
    delete (sanitized as Record<string, string>).authorization;
    delete (sanitized as Record<string, string>).Authorization;
    delete (sanitized as Record<string, string>)['Music-User-Token'];
    delete (sanitized as Record<string, string>)['Media-User-Token'];
    delete (sanitized as Record<string, string>).origin;
    delete (sanitized as Record<string, string>).referer;
  }
  return sanitized;
}

export function buildLicenseHeaders(headers: Record<string, string>): Record<string, string> {
  const token =
    headers['media-user-token'] ??
    headers['music-user-token'] ??
    headers['Media-User-Token'] ??
    headers['Music-User-Token'];
  const ua = headers['user-agent'] ?? headers['User-Agent'];
  const auth = headers.authorization ?? headers.Authorization;
  const payload: Record<string, string> = {
    connection: 'keep-alive',
    accept: 'application/json',
    origin: 'https://music.apple.com',
    referer: 'https://music.apple.com/',
    'accept-encoding': 'gzip, deflate, br',
    'content-type': 'application/json;charset=utf-8',
  };
  if (ua) payload['user-agent'] = ua;
  if (auth) payload.authorization = auth;
  if (token) payload['media-user-token'] = token;
  return payload;
}

export function normalizeLicenseUrl(url?: string): string | null {
  if (!url) return null;
  if (url.includes('play.itunes.apple.com')) {
    return url.replace('play.itunes.apple.com', 'play.music.apple.com');
  }
  return url;
}

export function asId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s.length ? s : undefined;
}
