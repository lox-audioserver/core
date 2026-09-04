/**
 * How a paired Bluetooth device is addressed as a playback client.
 *
 * A convention, not a computation: the input adapter registers the phone under this id and the
 * HTTP surfaces look it up by the same one. It lives here because those sit in different adapter
 * families, and formatting an id was otherwise a reason for the admin routes to load the whole
 * Bluetooth input service.
 */
export function bluetoothClientId(deviceId: string): string {
  return `${deviceId.trim()}-bt`;
}
