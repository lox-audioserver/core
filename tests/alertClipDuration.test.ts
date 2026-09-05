import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import {
  probeAlertDurationSeconds,
  setDurationDecoderForTests,
} from '../src/application/alerts/alertClipDuration';

// The alert stop timer is fed from this measurement, so a stale one cuts a clip
// off or holds the zone past the end. Alert sounds are replaced in place by the
// admin UI — same path, different audio — and reverted the same way, which is
// exactly what a cache keyed on the path alone could not see.
//
// The decoder is stubbed: the suite mocks every ffmpeg spawn globally, and what
// is under test is which answers get reused, not how a file is measured.

async function withTempFile(fn: (absPath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lox-alert-duration-'));
  try {
    await fn(path.join(dir, 'clip.mp3'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** A decoder that answers with the file's byte length, and counts its calls. */
function countingDecoder(): { decode: (p: string) => Promise<number>; calls: () => number } {
  let calls = 0;
  return {
    decode: async (absPath: string) => {
      calls += 1;
      const { size } = await fs.stat(absPath);
      return size;
    },
    calls: () => calls,
  };
}

test('a replaced alert clip is measured again, not remembered', async () => {
  await withTempFile(async (clip) => {
    const decoder = countingDecoder();
    const restore = setDurationDecoderForTests(decoder.decode);
    try {
      await fs.writeFile(clip, Buffer.alloc(3));
      assert.equal(await probeAlertDurationSeconds(clip), 3);

      // Replaced in place, the way updateAlertFile does it.
      await fs.writeFile(clip, Buffer.alloc(30));
      assert.equal(
        await probeAlertDurationSeconds(clip),
        30,
        'the length of the clip that is there now, not the one that was',
      );

      // And back, the way revertAlertFile does it.
      await fs.writeFile(clip, Buffer.alloc(3));
      assert.equal(await probeAlertDurationSeconds(clip), 3);
      assert.equal(decoder.calls(), 3, 'each different file was measured');
    } finally {
      restore();
    }
  });
});

test('an unchanged clip is answered from the cache, not measured twice', async () => {
  await withTempFile(async (clip) => {
    const decoder = countingDecoder();
    const restore = setDurationDecoderForTests(decoder.decode);
    try {
      await fs.writeFile(clip, Buffer.alloc(7));
      assert.equal(await probeAlertDurationSeconds(clip), 7);
      assert.equal(await probeAlertDurationSeconds(clip), 7);
      assert.equal(decoder.calls(), 1);
    } finally {
      restore();
    }
  });
});

test('a clip that is not there reports nothing rather than throwing', async () => {
  await withTempFile(async (clip) => {
    const restore = setDurationDecoderForTests(async () => undefined);
    try {
      assert.equal(await probeAlertDurationSeconds(clip), undefined);
    } finally {
      restore();
    }
  });
});

test('a measurement of zero is not cached, so a bad probe is retried', async () => {
  await withTempFile(async (clip) => {
    let calls = 0;
    const restore = setDurationDecoderForTests(async () => {
      calls += 1;
      return calls === 1 ? 0 : 5;
    });
    try {
      await fs.writeFile(clip, Buffer.alloc(1));
      assert.equal(await probeAlertDurationSeconds(clip), undefined);
      // A zero-length probe is the failure that #276 was about; it must not stick.
      assert.equal(await probeAlertDurationSeconds(clip), 5);
    } finally {
      restore();
    }
  });
});
