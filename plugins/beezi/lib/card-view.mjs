// What the startup card says, from the facts scripts/card.mjs prints. Pure: no $, no Node APIs.

// The Beezi mark in braille dots (2x4 per cell), traced from the portal's logo.svg.
export const LOGO_LINES = ['⣠⣴⡾ ⣀⣄', '⢛⣩⣴⣾⠟⣋', '⠻⠛⠉⣴⡿⠟'];

// What a new rule covers, as /beezi:settings rules says it (scripts/settings.mjs CARD_FOOTER).
const FOOTER = {
  repo: 'The rule follows the repo, so every clone of it stops sending too.',
  folder: 'The rule covers this folder and everything inside it.',
  outside: 'The rule covers every session in your home folder, / or a temp folder.',
};

export function versionText(facts) {
  return facts.version == null ? null : `v${facts.version}`;
}

export function updateText(facts) {
  return facts.update == null ? null : `v${facts.update.latest} available`;
}

// The numbered commands to update, or the /plugin hint when the cached check names no marketplace.
export function updateSteps(facts) {
  if (facts.update.commands == null) return ['Run /plugin to update it, then restart Claude Code to apply it.'];
  return [...facts.update.commands, 'Restart Claude Code to apply it.'].map((step, i) => `${i + 1}. ${step}`);
}

export function placeText(facts) {
  if (facts.place == null) return 'This session';
  return facts.place.kind === 'outside' ? 'Sessions outside a project' : facts.place.short;
}

function placeNoun(facts) {
  if (facts.place == null) return 'this session';
  return `the ${facts.place.short} ${facts.place.kind}`;
}

export function placeLine(facts) {
  if (facts.place == null || facts.place.kind === 'outside') return null;
  const kind = facts.place.kind === 'repo' ? 'a git repo' : 'a folder';
  return [facts.place.short, kind, facts.place.path, facts.place.remote].filter((part) => part != null).join(' · ');
}

export function question(facts, isPending) {
  if (facts.place != null && facts.place.kind === 'outside') {
    return isPending
      ? 'Sessions outside a project have no rule yet. Where should they go?'
      : 'Where should sessions outside a project go?';
  }
  const noun = placeNoun(facts);
  return isPending
    ? `${noun.charAt(0).toUpperCase()}${noun.slice(1)} has no rule yet. Where should its sessions go?`
    : `Where should sessions from ${noun} go?`;
}

export function dotColor(account) {
  if (account.route.kind === 'pending') return 'warning';
  if (account.route.kind === 'unknown' || account.route.ids.length === 0) return 'inactive';
  return account.note == null ? 'success' : 'warning';
}

// The choices for where this place's sessions go, each with the workspace.mjs arguments that save it.
export function optionsFor(facts, account) {
  const where = placeText(facts);
  const footer = facts.place == null ? '' : ` ${FOOTER[facts.place.kind]}`;
  const route = account.route;
  const own = route.kind === 'rule' && route.isOwnRule && route.ruleIndex != null;
  const write = (ids) => (own
    ? ['rule', 'set', String(route.ruleIndex), ids, '--account', account.key]
    : ['rule', 'add', '--current', ids, '--account', account.key]);
  const decided = route.kind === 'default' || route.kind === 'rule';
  const off = {
    label: "Don't track",
    hint: `Nothing from here is sent.${footer}`,
    argv: write('none'),
    done: `${where} → not tracked`,
    isCurrent: decided && route.ids.length === 0,
  };
  if (account.isMulti) {
    return account.workspaces.map((w) => {
      const isCurrent = decided && route.ids.length === 1 && route.ids[0] === w.id;
      return {
        label: w.name,
        hint: [w.role, isCurrent ? 'where it goes now' : ''].filter((part) => part !== '').join(' · '),
        argv: write(w.id),
        done: `${where} → ${w.name}`,
        isCurrent,
      };
    }).concat([off]);
  }
  const only = account.workspaces[0];
  if (only == null) return [];
  if (route.ids.length > 0) return [{ ...off, label: "Don't track here", hint: `Stops sending to ${only.name}.${footer}` }];
  if (!own) return [];
  return [{
    label: `Track in ${only.name}`,
    hint: `Removes rule R${route.ruleIndex}, so sessions go to ${only.name} again.`,
    argv: ['rule', 'remove', String(route.ruleIndex), '--account', account.key],
    done: `${where} → ${only.name}`,
    isCurrent: false,
  }];
}

// The account the card's change button opens: the default one with choices, else the first with any.
export function changeTarget(facts) {
  const hasChoices = (a) => optionsFor(facts, a).length > 0;
  return facts.accounts.find((a) => a.isDefault && hasChoices(a)) || facts.accounts.find(hasChoices);
}
