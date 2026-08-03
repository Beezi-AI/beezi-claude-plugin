import { trackSession } from '../lib/track-session.mjs';
import { resolveSessionTranscript } from '../lib/transcript.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

const cwd = process.cwd();

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main() {
  const transcript = resolveSessionTranscript(cwd);
  if (!transcript) {
    fail('Beezi: could not find this session’s transcript to track.');
  }

  const { ok, message } = await trackSession({
    sessionId: transcript.sessionId,
    transcriptPath: transcript.transcriptPath,
    cwd,
  });
  if (!ok) fail(message);
  console.log(`✓ ${message}`);
}

main().catch((error) => fail(friendlyMessage(error)));
