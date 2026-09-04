/**
 * What Spotify actually delivered, and what normalisation costs.
 *
 * Nothing in Soloist reports a codec, a bitrate or a quality tier: its WebSocket carries status,
 * item, position, volume and little else, and every tier decodes to float, so the sound card
 * cannot tell them apart either. What can be measured is the cache — one content-addressed file
 * per track — against the track's own duration, which is its exact average bitrate. Credit for the
 * idea to foonerd/alsa_soloist_connect, which does the same for Volumio.
 *
 * Two modes:
 *   tier    play a track and read the tier off the cache file
 *   gain    play the same track twice, with normalisation on and off, and compare the amplitude
 *
 * The second is the one that says whether a stream is bit-exact. Volume is not a taper here — see
 * `scripts/soloist-volume-probe.ts` — but normalisation is a real gain on every sample.
 *
 *   SOLOIST_KEY=spak_… npx tsx scripts/soloist-quality-probe.ts [tier|gain]
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PulseSoundCard } from '@/adapters/inputs/pulse/pulseSoundCard';
import { SoloistTrackRun } from '@/adapters/inputs/spotify/soloist/soloistTrackRun';
import { accountStore } from '@/adapters/inputs/spotify/soloist/soloistProcess';

const ZONE_ID = 991;
const ACCOUNT = process.env.ACCOUNT ?? 'md123121';
const URI = process.env.URI ?? 'spotify:track:4cOdK2wGLETKBW3PvgPWqT';
/** Long enough for a cache file to finish and for an amplitude to be worth comparing. */
const LISTEN_MS = Number(process.env.LISTEN ?? 20_000);

/** Spotify's tiers, as kbps floors. The lossless floor sits well under FLAC's ~1000+. */
const TIERS: Array<{ name: string; floor: number }> = [
  { name: 'Lossless', floor: 700 },
  { name: 'Very High', floor: 250 },
  { name: 'High', floor: 130 },
  { name: 'Normal', floor: 70 },
  { name: 'Low', floor: 0 },
];

const tierOf = (kbps: number): string => TIERS.find((tier) => kbps >= tier.floor)!.name;

/** Every process playing out of this store, crashpad's helper excluded. */
async function pidsFor(dataDir: string): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await fsp.readdir('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const cmdline = await fsp.readFile(`/proc/${entry}/cmdline`, 'utf8');
      if (cmdline.includes(dataDir) && !cmdline.includes('crashpad-handler')) {
        pids.push(Number(entry));
      }
    } catch {
      // Processes come and go while this reads; one that left is simply not a candidate.
    }
  }
  return pids;
}

/**
 * The audio files this process is holding open, by size.
 *
 * By open descriptor rather than by modification time: under skipping there are several partial
 * downloads in flight and the newest file is not reliably the one playing. LevelDB's own files live
 * in the store as well and are not audio.
 */
async function openPayloads(pids: number[], cacheDir: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const pid of pids) {
    let fds: string[] = [];
    try {
      fds = await fsp.readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = await fsp.readlink(`/proc/${pid}/fd/${fd}`);
        if (!target.startsWith(cacheDir) || /\.(ldb|log|sst)$|MANIFEST|LOCK|CURRENT/.test(target)) {
          continue;
        }
        const stat = await fsp.stat(target);
        if (stat.isFile() && stat.size > 0) {
          sizes.set(target, Math.max(sizes.get(target) ?? 0, stat.size));
        }
      } catch {
        // A descriptor that closed between the listing and the read.
      }
    }
  }
  return sizes;
}

type Listened = {
  peak: number;
  rms: number;
  bytes: number;
  durationMs: number;
  payloads: Map<string, number>;
};

/** Play one track, listen to what the card is handed, and watch the cache while it plays. */
async function listen(card: PulseSoundCard, normalize: boolean): Promise<Listened | null> {
  const store = accountStore(ACCOUNT);
  card.forgetSpec(ZONE_ID);
  const started = await SoloistTrackRun.start({
    zoneId: ZONE_ID,
    uri: URI,
    accountId: ACCOUNT,
    apiKey: process.env.SOLOIST_KEY as string,
    deviceName: 'Quality probe',
    lossless: true,
    normalize,
    seekPositionMs: 0,
    env: await card.childEnv(ZONE_ID),
    onEnd: () => undefined,
  });
  if (!started.ok) {
    console.log(`refused: ${started.failure}`);
    return null;
  }
  const run = started.run;
  // The duration is Soloist's own, and it is the denominator of the whole measurement.
  let durationMs = 0;
  (run as unknown as { ws: { on: (e: string, fn: (event: unknown) => void) => void } }).ws.on(
    'event',
    (event) => {
      const ms = (event as { item?: { decorations?: { playback?: { duration_ms?: number } } } }).item
        ?.decorations?.playback?.duration_ms;
      if (typeof ms === 'number' && ms > 0) {
        durationMs ||= ms;
      }
    },
  );

  await card.waitForSpec(ZONE_ID);
  const stream = card.takeStream(ZONE_ID);
  let peak = 0;
  let sumSquares = 0;
  let samples = 0;
  let bytes = 0;
  stream?.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    for (let i = 0; i + 3 <= chunk.length; i += 3) {
      const raw = chunk.readUIntLE(i, 3);
      const value = (raw >= 0x800000 ? raw - 0x1000000 : raw) / 8388607;
      peak = Math.max(peak, Math.abs(value));
      sumSquares += value * value;
      samples += 1;
    }
  });

  const pids = await pidsFor(store.data);
  const payloads = new Map<string, number>();
  const deadline = Date.now() + LISTEN_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    for (const [file, size] of await openPayloads(pids, store.cache)) {
      payloads.set(file, Math.max(payloads.get(file) ?? 0, size));
    }
  }
  await run.stop();
  return {
    peak,
    rms: samples > 0 ? Math.sqrt(sumSquares / samples) : 0,
    bytes,
    durationMs,
    payloads,
  };
}

const dB = (ratio: number): string => (ratio > 0 ? `${(20 * Math.log10(ratio)).toFixed(2)} dB` : '-inf');

async function main(): Promise<void> {
  const mode = process.argv[2] === 'gain' ? 'gain' : 'tier';
  const card = new PulseSoundCard('quality');
  await card.ensure(ZONE_ID);

  if (mode === 'tier') {
    const heard = await listen(card, true);
    if (!heard) {
      process.exit(1);
    }
    console.log(`\ntrack ${URI}, duration ${(heard.durationMs / 1000).toFixed(1)} s`);
    if (heard.payloads.size === 0) {
      console.log('no cache file was open; the track may have been served entirely from memory');
    }
    for (const [file, size] of heard.payloads) {
      const kbps = heard.durationMs > 0 ? (size * 8) / (heard.durationMs / 1000) / 1000 : 0;
      console.log(
        `  ${path.basename(file)}  ${(size / 1e6).toFixed(2)} MB  ` +
          `${kbps.toFixed(0)} kbps  ${tierOf(kbps)}`,
      );
    }
    await card.stop();
    process.exit(0);
  }

  const on = await listen(card, true);
  const off = await listen(card, false);
  if (!on || !off) {
    process.exit(1);
  }
  console.log(`\nnormalisation on   peak ${on.peak.toFixed(5)}  rms ${on.rms.toFixed(5)}`);
  console.log(`normalisation off  peak ${off.peak.toFixed(5)}  rms ${off.rms.toFixed(5)}`);
  console.log(
    `difference         peak ${dB(off.peak / on.peak)}  rms ${dB(off.rms / on.rms)}\n` +
      'Anything but zero is a gain applied to every sample, which is what bit-exact means here.',
  );
  await card.stop();
  process.exit(0);
}

void main();
