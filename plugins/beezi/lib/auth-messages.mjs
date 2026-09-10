import { AUTH_STATES, AUTH_REASONS } from './auth-state.mjs';

// One place for what each authentication state is called in front of a user, so the session-start
// banner, /beezi:me and the MCP bridge cannot drift apart.
//
// The rules the plan pins: "not linked" means no saved authorization and nothing else; a
// temporary failure describes retrying; a 403 describes missing permission; a confirmed
// rejection asks for reauthorization once. Nothing here ever suggests /beezi:login for a
// failure a login cannot fix — that is the loop that used to delete a refreshable session.

export const UPGRADE_RESTART_NOTICE =
  'Beezi upgraded how it stores your login on this machine. Restart Claude Code to finish the '
  + 'upgrade — until then, an older Beezi process may keep renewing the previous copy.';

// The short line a hook prints. `null` when there is nothing worth interrupting the user with.
export function authNotice(auth) {
  switch (auth.authState) {
    case AUTH_STATES.READY:
      return null;
    case AUTH_STATES.UNLINKED:
      return '⚠ Beezi: this machine is not linked — analytics are NOT being tracked. '
        + 'Run /beezi:login to link it.';
    case AUTH_STATES.REFRESHING:
      return 'Beezi: renewing this machine’s authorization — analytics resume on their own in a moment.';
    case AUTH_STATES.REAUTH_REQUIRED:
      return `⚠ Beezi: ${reauthSentence(auth.reason)} Run /beezi:login to authorize this machine again.`;
    default:
      return `Beezi: ${unavailableSentence(auth.reason)} Your saved authorization is untouched and `
        + 'Beezi will retry on its own.';
  }
}

// What /beezi:me says: the same verdict, in full sentences, with no hook-banner urgency.
export function authStatusLines(auth) {
  switch (auth.authState) {
    case AUTH_STATES.UNLINKED:
      return ['Beezi: this machine is not linked. Run /beezi:login to link it.'];
    case AUTH_STATES.REFRESHING:
      return [
        'Beezi: this machine is linked; its authorization is being renewed right now.',
        '  Try /beezi:me again in a moment.',
      ];
    case AUTH_STATES.REAUTH_REQUIRED:
      return [
        `Beezi: ${reauthSentence(auth.reason)}`,
        '  Your saved authorization is still on this machine — run /beezi:login to authorize it again.',
      ];
    case AUTH_STATES.UNAVAILABLE:
      return [
        `Beezi: ${unavailableSentence(auth.reason)}`,
        '  This machine is still linked; nothing was removed. Beezi retries on its own.',
      ];
    default:
      return [];
  }
}

function reauthSentence(reason) {
  if (reason === AUTH_REASONS.CONSENT_REQUIRED || reason === AUTH_REASONS.MISSING_REFRESH_TOKEN) {
    return 'this machine’s authorization cannot be renewed without your consent.';
  }
  return 'the login server no longer accepts this machine’s saved authorization.';
}

function unavailableSentence(reason) {
  switch (reason) {
    case AUTH_REASONS.STORAGE_UNAVAILABLE:
      return 'could not read this machine’s saved login just now.';
    case AUTH_REASONS.STORAGE_CONFLICT:
      return 'found two different saved logins on this machine; run /beezi:login to settle it.';
    case AUTH_REASONS.LOCK_TIMEOUT:
      return 'another Beezi process is using the saved login.';
    case AUTH_REASONS.REFRESH_INTERRUPTED:
      return 'renewing this machine’s authorization was interrupted.';
    case AUTH_REASONS.REFRESH_TIMEOUT:
      return 'renewing this machine’s authorization took too long.';
    case AUTH_REASONS.VERIFICATION_UNAVAILABLE:
      return 'could not verify this machine’s login — the server said it cannot check right now.';
    case AUTH_REASONS.RATE_LIMITED:
      return 'is being rate limited by the server.';
    default:
      return 'could not renew this machine’s authorization just now.';
  }
}

// A 403 is a verdict on the account, not the credential: signing in again changes nothing.
export const FORBIDDEN_NOTICE =
  '⚠ Beezi: this account does not have access here — analytics are NOT being tracked. '
  + 'Ask your Beezi administrator about your seat or workspace access; signing in again will not change it.';

export const FORBIDDEN_STATUS_LINES = [
  'Beezi: this machine is linked, but the account does not have access here.',
  '  Ask your Beezi administrator about your seat or workspace access — /beezi:login will not change it.',
];

export const VERIFICATION_UNAVAILABLE_STATUS_LINES = [
  'Beezi: the server could not check this machine’s link right now.',
  '  Nothing is wrong with your saved login; try again in a moment.',
];
