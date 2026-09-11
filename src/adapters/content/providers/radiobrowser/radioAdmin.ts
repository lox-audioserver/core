import type { RadioAdminPort } from '@/ports/RadioAdminPort';
import { openStreamPreview } from '@/application/playback/streamPreview';
import {
  reportRadioStationPicked,
  searchRadioStations,
} from '@/adapters/content/providers/radiobrowser/radioBrowserAdmin';

/**
 * The radio admin surface as the admin API sees it.
 *
 * Composition only. Searching is radio-browser's; previewing is the playback path's and
 * knows nothing about where a url came from — the screen needs both, and this is the one
 * place that says so.
 */
export const radioAdmin: RadioAdminPort = {
  searchStations: (query, limit) => searchRadioStations(query, limit),
  reportStationPicked: (stationId) => reportRadioStationPicked(stationId),
  openPreview: (url) => openStreamPreview(url),
};
