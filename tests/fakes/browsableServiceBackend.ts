import type { BrowsableServiceBackend } from '../../src/adapters/content/browsableServices';

/**
 * A backend the catalogue can bind to but that refuses to be browsed.
 *
 * For tests that read each service's identity — key, title, search source — and never open one.
 * It rejects rather than returning empty on purpose: a test that starts browsing should fail
 * loudly here instead of quietly seeing nothing.
 */
export const notBrowsed: BrowsableServiceBackend = {
  getMediaFolder: () => Promise.reject(new Error('not browsed in this test')),
  getRadioFolder: () => Promise.reject(new Error('not browsed in this test')),
  getServiceFolder: () => Promise.reject(new Error('not browsed in this test')),
  getRelatedArtists: () => Promise.reject(new Error('not browsed in this test')),
};
