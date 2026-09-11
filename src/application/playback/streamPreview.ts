import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import { ffmpegBinary } from '@/engine/ffmpegProcess';
import { buildProxyUrl } from '@/shared/urlProxy';
import type { StreamPreview } from '@/ports/RadioAdminPort';

/** Long enough to judge a station, short enough that a forgotten tab does not hold a decoder. */
const PREVIEW_MAX_MS = 5 * 60 * 1000;
/** A stream that has not produced a sample by now is not going to. */
const PREVIEW_START_TIMEOUT_MS = 15_000;
const PREVIEW_BITRATE = '128k';

const log = createLogger('Playback', 'StreamPreview');

/**
 * The one preview running right now, if any.
 *
 * A test bench listens to one stream at a time — picking the next station should replace the
 * sound, not add to it. Holding the slot here rather than trusting the browser to close the
 * old request means a reload cannot leave a decoder behind either.
 */
let active: { stop: (reason: string) => void } | null = null;

export function stopActiveStreamPreview(reason: string): void {
  active?.stop(reason);
}

/**
 * Listen to a stream url without giving it a zone.
 *
 * The point of a test button is to answer "will this play here", and only the real path can
 * answer that. So the url goes through our own audio proxy — which is what follows a `.pls`
 * or `.m3u` pointer and rewrites an HLS manifest — and then through ffmpeg, exactly as a
 * zone's session does. What comes back out is mp3, because that is the one thing every
 * browser plays from a plain `<audio>` element: no hls.js, no codec matrix, no guessing
 * whether this one took the AAC.
 *
 * Nothing is handed back until the first sample arrives, so a station that cannot be reached
 * fails as an error the caller can show rather than as a silent player that looks like it is
 * working — which is the difference between a test button and a decoration.
 */
export function openStreamPreview(url: string): Promise<StreamPreview> {
  stopActiveStreamPreview('replaced by a new preview');

  const target = buildProxyUrl(url) ?? url;
  const child = spawn(
    ffmpegBinary(),
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-i', target,
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', PREVIEW_BITRATE,
      '-f', 'mp3',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  return new Promise<StreamPreview>((resolve) => {
    const body = new PassThrough();
    let streaming = false;
    let settled = false;
    // ffmpeg says why it gave up on stderr, and the last line of it is what makes a failed
    // preview diagnosable: "Server returned 404 Not Found" beats "could not play".
    let stderrTail = '';

    const settle = (result: StreamPreview): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(startTimer);
      resolve(result);
    };

    const stop = (reason: string): void => {
      clearTimeout(startTimer);
      clearTimeout(maxTimer);
      if (active?.stop === stop) {
        active = null;
      }
      if (!child.killed) {
        log.debug('stream preview stopped', { reason, url });
        child.kill('SIGKILL');
      }
      body.end();
    };

    const fail = (
      error: Extract<StreamPreview, { ok: false }>['error'],
      detail?: string,
    ): void => {
      if (!settled) {
        log.info('stream preview failed', { url, error, detail });
      }
      settle({ ok: false, error, ...(detail ? { detail } : {}) });
      stop(error);
    };

    const startTimer = setTimeout(() => fail('preview-timeout', lastLine(stderrTail)), PREVIEW_START_TIMEOUT_MS);
    const maxTimer = setTimeout(() => stop('preview time limit reached'), PREVIEW_MAX_MS);
    active = { stop };

    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded: a stream that complains once per frame must not grow this without end.
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2000);
    });

    // The pipe is attached inside the handler, in the same tick, so no data can slip past
    // between the sample that proves the stream works and the rest of it.
    child.stdout.once('data', (chunk: Buffer) => {
      streaming = true;
      body.write(chunk);
      child.stdout.pipe(body);
      settle({ ok: true, body, stop });
    });

    child.on('error', (err) => fail('preview-spawn-failed', err.message));
    child.on('close', (code) => {
      if (streaming) {
        stop(`ffmpeg exited (${code})`);
        return;
      }
      fail('preview-unplayable', lastLine(stderrTail));
    });
  });
}

/** The line ffmpeg ended on — the reason, with the noise before it dropped. */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}
