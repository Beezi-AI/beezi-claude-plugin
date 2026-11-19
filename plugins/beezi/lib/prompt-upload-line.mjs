import { readJson } from './fs-store.mjs';
import { accountsIndexFile } from './paths.mjs';
import { isLive, listProgress, markReported } from './upload-progress.mjs';
import { doneLine } from './upload-progress-view.mjs';

const INDEX_VERSION = 1;
const LINKED = 'linked';

// Read straight from disk: accounts.mjs reaches the credential store, which a prompt hook must not.
export function linkedAccountKeys() {
  const index = readJson(accountsIndexFile(), null);
  if (index == null || index.version !== INDEX_VERSION || !Array.isArray(index.accounts)) return [];
  return index.accounts.filter((a) => a != null && a.status === LINKED && typeof a.key === 'string').map((a) => a.key);
}

// The lines one prompt adds while the card isn't drawing; a done line is shown once, then marked reported. A run that
// did not end clean (failed) gets neither: the worker carries the rest.
export function promptUploadLines({ keys, sessionId, cardSession, now, list = listProgress, mark = markReported }) {
  if (cardSession != null && cardSession === sessionId) return [];
  const lines = [];
  for (const key of keys) {
    for (const record of list(key)) {
      if (isLive(record, now)) {
        lines.push(`Beezi: uploading past sessions to ${record.workspace}  ${record.processed}/${record.total}`);
      } else if (record.finishedAt != null && !record.reported && record.failed !== true) {
        lines.push(doneLine(record));
        mark(record.key, record.tenantId);
      }
    }
  }
  return lines;
}
