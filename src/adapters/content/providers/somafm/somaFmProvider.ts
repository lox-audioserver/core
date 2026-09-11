import type { ContentFolder, ContentFolderItem, RadioMenuEntry } from '@/ports/ContentTypes';
import {
  SomaFmClient,
  type SomaFmChannel,
} from '@/adapters/content/providers/somafm/somaFmClient';

const PROVIDER_ID = 'somafm';
const ICON_URL = 'https://api.somafm.com/logos/256/sfmlogo256.png';

/**
 * SomaFM's channels as a radio source.
 *
 * Like TuneIn presets and custom streams — and unlike Radio Paradise — a channel's audiopath
 * is simply its stream url. Nothing on the playing side has to learn anything: the url is a
 * `.pls` naming the real stream, and the proxy has followed those since #368.
 */
export class SomaFmProvider {
  private readonly api = new SomaFmClient();

  public getMenuEntry(): RadioMenuEntry {
    return {
      cmd: PROVIDER_ID,
      name: 'SomaFM',
      icon: ICON_URL,
      root: 'start',
      description: 'Listener-supported, commercial-free channels from San Francisco.',
    };
  }

  public async getFolder(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    if (folderId !== 'start') {
      return null;
    }
    const channels = await this.api.channels();
    const stations = channels
      .map((channel) => this.toItem(channel))
      .filter((item): item is ContentFolderItem => item !== null)
      // By name, not by listener count. Popularity is the more useful order on a website and
      // the worse one in a menu: a list that reshuffles between visits cannot be learned.
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      id: folderId,
      name: 'SomaFM',
      start: offset,
      totalitems: stations.length,
      items: stations.slice(offset, offset + limit),
    };
  }

  private toItem(channel: SomaFmChannel): ContentFolderItem | null {
    const id = channel.id?.trim();
    const name = channel.title?.trim();
    const stream = channel.playlists?.find((entry) => /^https?:\/\//i.test(entry?.url ?? ''))?.url;
    if (!id || !name || !stream) {
      return null;
    }
    // The feed lists the same four streams for every channel in one order, best first, so
    // taking the first is SomaFM's own preference rather than a guess of ours.
    const cover = channel.xlimage?.trim() || channel.largeimage?.trim() || channel.image?.trim() || ICON_URL;
    return {
      id: `somafm_${id}`,
      name,
      title: name,
      kind: 'radio',
      tag: 'radio',
      audiopath: stream,
      coverurl: cover,
      thumbnail: cover,
      provider: PROVIDER_ID,
      items: 0,
    } satisfies ContentFolderItem;
  }
}
