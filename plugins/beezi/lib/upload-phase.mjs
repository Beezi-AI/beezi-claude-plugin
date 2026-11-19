// Pure upload-phase text shared by the setup follower, the plain follower and the card: no imports, no Node API.

const SPINNER_FRAMES = {
  unicode: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  ascii: ['|', '/', '-', '\\'],
};

export const FINISHING_PLAIN = 'Beezi: all sessions read, finishing upload…';

export function spinnerFrame(tick, { ascii = false } = {}) {
  const frames = ascii ? SPINNER_FRAMES.ascii : SPINNER_FRAMES.unicode;
  return frames[tick % frames.length];
}

// Every session is read; the run is still sending its last batches.
export function isFinishing(record) {
  return record.total > 0 && record.processed >= record.total;
}

export function finishingText(workspace) {
  return `Finishing upload to ${workspace}…`;
}
