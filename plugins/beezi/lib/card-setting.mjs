import { readJson, writeJsonSecure } from './fs-store.mjs';
import { cardSettingFile } from './paths.mjs';

// Whether the Beezi card draws above the prompt; on until turned off.
export function cardEnabled() {
  const raw = readJson(cardSettingFile());
  return raw == null || raw.enabled !== false;
}

export function setCardEnabled(on) {
  writeJsonSecure(cardSettingFile(), { version: 1, enabled: on === true });
}
