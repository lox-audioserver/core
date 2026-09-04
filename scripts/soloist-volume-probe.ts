/**
 * Whether Soloist's own volume touches the samples this server receives.
 *
 * The `-i 100` pin exists to keep the stream bit-exact, on the reading that anything below 100 is
 * applied in software before the sink. This measures it: one track, the level moved twice
 * mid-flight, and the amplitude of what the sound card is handed either side of each move.
 *
 *   SOLOIST_KEY=spak_… npx tsx scripts/soloist-volume-probe.ts
 */
import { PulseSoundCard } from '@/adapters/inputs/pulse/pulseSoundCard';
import { SoloistTrackRun } from '@/adapters/inputs/spotify/soloist/soloistTrackRun';

const ZONE_ID = 993;
const ACCOUNT = process.env.ACCOUNT ?? 'md123121';
const URI = process.env.URI ?? 'spotify:track:4cOdK2wGLETKBW3PvgPWqT';

/** Peak of a window of 24-bit little-endian samples, as a fraction of full scale. */
function peakS24(buf: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 3 <= buf.length; i += 3) {
    const raw = buf.readUIntLE(i, 3);
    const value = raw >= 0x800000 ? raw - 0x1000000 : raw;
    peak = Math.max(peak, Math.abs(value));
  }
  return peak / 8388607;
}

async function main(): Promise<void> {
  const card = new PulseSoundCard('volprobe');
  await card.ensure(ZONE_ID);
  const started = await SoloistTrackRun.start({
    zoneId: ZONE_ID,
    uri: URI,
    accountId: ACCOUNT,
    apiKey: process.env.SOLOIST_KEY as string,
    deviceName: 'Volume probe',
    lossless: true,
    normalize: true,
    seekPositionMs: 30_000,
    env: await card.childEnv(ZONE_ID),
    onEnd: (end) => console.log(`run ended: ${JSON.stringify(end)}`),
  });
  if (!started.ok) {
    console.log(`refused: ${started.failure}`);
    process.exit(1);
  }
  const run = started.run;
  const ws = (run as unknown as { ws: { setVolume: (v: number) => boolean } }).ws;
  const spec = await card.waitForSpec(ZONE_ID);
  console.log(`delivered spec: ${JSON.stringify(spec)}`);
  const stream = card.takeStream(ZONE_ID);

  const t0 = Date.now();
  let window = Buffer.alloc(0);
  let asked = 100;
  stream?.on('data', (chunk: Buffer) => {
    window = Buffer.concat([window, chunk]);
    // ~0.25 s at 44.1 kHz stereo 24-bit.
    if (window.length >= 66_150) {
      console.log(
        `+${String(Date.now() - t0).padStart(5)}ms  asked=${String(asked).padStart(3)}  ` +
          `peak=${peakS24(window).toFixed(4)}`,
      );
      window = Buffer.alloc(0);
    }
  });

  const at = (ms: number, level: number) =>
    setTimeout(() => {
      asked = level;
      console.log(`>>> set_volume ${level}: sent=${ws.setVolume(level)}`);
    }, ms);
  at(4_000, 20);
  at(9_000, 100);
  at(14_000, 5);

  setTimeout(async () => {
    await run.stop();
    await card.stop();
    process.exit(0);
  }, 19_000);
}

void main();
