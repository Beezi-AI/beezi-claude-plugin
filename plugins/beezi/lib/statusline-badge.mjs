import { readJson, writeJsonSecure } from './fs-store.mjs';
import { statuslineBadgeFile } from './paths.mjs';

// Whether the status line ends with the Beezi badge; off until turned on. Kept tiny: the status line reads it on every render.
export function badgeEnabled() {
  const raw = readJson(statuslineBadgeFile());
  return raw != null && raw.enabled === true;
}

export function setBadgeEnabled(on) {
  writeJsonSecure(statuslineBadgeFile(), { version: 1, enabled: on === true });
}
