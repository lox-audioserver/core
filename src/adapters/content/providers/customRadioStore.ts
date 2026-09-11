import { randomUUID } from 'node:crypto';
import {
  ensureDir,
  readOrDefaultJson,
  resolveDataDir,
  writeJson,
} from '@/shared/utils/file';

export interface CustomRadioEntry {
  id: string;
  name: string;
  stream: string;
  coverurl?: string;
  /**
   * Where the entry came from, when it was picked out of an index rather than typed.
   *
   * The stream url alone makes a saved station anonymous forever: nothing can say later
   * whether it moved, and nothing can look it up again. The id of the record it was copied
   * from is the one thing that cannot be reconstructed afterwards, so it is kept even though
   * nothing reads it yet.
   */
  source?: { provider: 'radiobrowser'; stationId: string };
}

/**
 * Minimal persistence layer for user defined radio stations.
 * Data is stored inside the application data directory so that stations survive restarts.
 */
export class CustomRadioStore {
  private readonly filePath = resolveDataDir('customradio', 'stations.json');
  private entries: CustomRadioEntry[] = [];
  private loaded = false;

  public async list(): Promise<CustomRadioEntry[]> {
    await this.ensureLoaded();
    return [...this.entries];
  }

  public async add(entry: Omit<CustomRadioEntry, 'id'>): Promise<CustomRadioEntry> {
    await this.ensureLoaded();
    const record: CustomRadioEntry = {
      id: randomUUID(),
      ...entry,
    };
    this.entries.push(record);
    await this.persist();
    return record;
  }

  public async update(
    id: string,
    changes: Partial<Omit<CustomRadioEntry, 'id'>>,
  ): Promise<CustomRadioEntry | undefined> {
    await this.ensureLoaded();
    const idx = this.entries.findIndex((entry) => entry.id === id);
    if (idx === -1) {
      return undefined;
    }
    const existing = this.entries[idx]!;
    this.entries[idx] = { ...existing, ...changes };
    await this.persist();
    return this.entries[idx];
  }

  public async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.entries.length !== before) {
      await this.persist();
      return true;
    }
    return false;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    await ensureDir(resolveDataDir('customradio'));
    this.entries = await readOrDefaultJson<CustomRadioEntry[]>(
      this.filePath,
      [],
      true,
    );
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await writeJson(this.filePath, this.entries);
  }
}
