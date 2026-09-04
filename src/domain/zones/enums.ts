/**
 * -----------------------------------------------------------------------------
 * Categories the server uses to describe what a zone is playing.
 * -----------------------------------------------------------------------------
 * These are domain concepts — source kind, media kind, repeat strategy, power
 * state — used throughout the application layer, not just by one consumer.
 *
 * Their *numeric values* are Loxone's, mirroring the official Audio Server UI
 * (assets/www/scripts/AppHub.js) so the state can go onto that wire unchanged.
 * That is a wire-compatibility detail, not a reason to treat them as Loxone
 * types: reading `AudioType.Radio` is what makes the surrounding code legible,
 * and `1` is only how it happens to serialise. The public API projects these
 * onto readable strings (`ApiSourceKind`) so no integrator has to know the
 * numbers at all.
 * -----------------------------------------------------------------------------
 */

/** Source category for the currently playing item. */
export enum AudioType {
  File = 0,
  Radio = 1,
  Playlist = 2,
  LineIn = 3,
  AirPlay = 4,
  Spotify = 5,
  Bluetooth = 6,
  Soundsuit = 7,
}

/** Special "audio events" triggered by the server (bells, alarms, etc.). */
export enum AudioEventType {
  Unknown = -1,
  None = 0,
  Bell = 1,
  Buzzer = 2,
  TTS = 3,
  ErrorTTS = 4,
  CustomFile = 5,
  CustomPlaylist = 6,
  UploadedFile = 7,
  Identify = 8,
  UpnpBell = 9,
  Alarm = 100,
  Fire = 101,
}

/** Playback repeat strategy applied to the queue. */
export enum RepeatMode {
  NoRepeat = 0,
  Queue = 1,
  Track = 3,
}

/**
 * Kind of media object currently addressed, and how the client renders a browse row.
 *
 * Read off the client's own `FileType` in `data/refcode/www/scripts/legacy/comps.js`, which is
 * the only authority on these numbers — the values below match it exactly.
 *
 * Four of them describe the same *thing* and differ only in the affordance the row gets, which
 * is why `ContentItemKind` cannot derive them: a playlist is `Playlist`, `PlaylistBrowsable`,
 * `PlaylistEditable` or `PlaylistFollowable` depending on whether the app may open it, edit it
 * or offer a follow toggle. `PlaylistBrowsable` is the safe default for a container that says
 * nothing more.
 */
export enum FileType {
  Unknown = 0,
  Folder = 1,
  /** A directly playable item: a track, a radio station, a podcast episode. */
  File = 2,
  Playlist = 3,
  Favorite = 4,
  SpotifyConnect = 5,
  LineIn = 6,
  /** A container the app may open. The default for album, artist, playlist, show, category. */
  PlaylistBrowsable = 7,
  Search = 8,
  PlaylistEditable = 11,
  /**
   * A container the app draws a follow toggle on.
   *
   * 12, not 13: this was declared as 13 here, a value the client's enum does not have at all.
   * Nothing read the name — every producer writes the literal `12` — so the wire was right and
   * only this declaration was wrong, but anyone reaching for the name would have emitted an
   * item the app cannot classify.
   */
  PlaylistFollowable = 12,
}

/** Icon to display for line-in sources within the client UI. */
export enum LineInIconType {
  LineIn = 0,
  CdPlayer = 1,
  Computer = 2,
  IMac = 3,
  IPod = 4,
  Mobile = 5,
  Radio = 6,
  Screen = 7,
  TurnTable = 8,
}

/** Playback mode. */
export enum AudioPlaybackMode {
  Play = 'play',
  Resume = 'resume',
  Stop = 'stop',
  Pause = 'pause',
}

/** Player power state. */
export enum AudioPowerState {
  Rebooting = 'rebooting',
  Updating = 'updating',
  Starting = 'starting',
  On = 'on',
  Off = 'off',
  Offline = 'offline',
}
