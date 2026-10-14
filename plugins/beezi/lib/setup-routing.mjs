const DONT_TRACK = {
  repo: "Don't track this repo",
  folder: "Don't track this folder",
  outside: "Don't track these",
};
const NEW_FOLDER_OPTIONS = [
  { label: 'Ask me (recommended)', description: 'Beezi asks once per repo or folder, when a session starts there' },
  { label: 'Send to…', description: 'Pick the workspaces that get them' },
  { label: "Don't send", description: 'Nothing from a repo or folder with no rule is uploaded' },
];
const LABEL_END = /\), \d+ sessions?\b/;
const PLAIN_PLACE = /^(.*?), \d+ sessions?\b/;
const NO_FOLDER = /^\d+ other past sessions? ha(?:s|ve) no recorded folder and (?:is|are) not sent\.$/;
const JOINED_NAMES = / you joined (.+) — \d+ repos? or folders? to review account=/;
const MACHINE_LINES = [/^[\w-]+=/, /^[A-Z]\d*\. .* account=/, /-command=/, /^\s*[{[]/];
const STOPPED = '✗ That step stopped unexpectedly.';
const CONSENT = ' Their past sessions will be sent there too.';
// Writes leave the upload to the wizard's backfill that follows.
const DEFER = '--defer-upload';

export function outputLines(text) {
  return String(text || '').split(/\r?\n/);
}

export function lastLine(text, pattern) {
  const matches = outputLines(text).filter((line) => pattern.test(line));
  return matches.length ? matches[matches.length - 1] : null;
}

// Value of the space-free `name=` field; null when the line has none.
export function token(line, name) {
  const found = new RegExp(`(?:^| )${name}=(\\S*)`).exec(line);
  return found ? found[1] : null;
}

function printable(text) {
  return outputLines(text).map((line) => line.trimEnd()).filter((line) => line !== '');
}

export function report(ctx, result) {
  if (result.code === 0) {
    const lines = printable(result.stdout);
    if (lines.length) ctx.print(lines[0]);
    return;
  }
  if (result.stderr.trim() !== '') {
    printable(result.stderr).forEach((line) => ctx.print(line));
    return;
  }
  const human = printable(result.stdout).filter((line) => !MACHINE_LINES.some((pattern) => pattern.test(line)));
  if (human.length === 0) human.push(STOPPED);
  human.forEach((line) => ctx.print(line));
}

export function parseWorkspaces(text) {
  return outputLines(text).filter((line) => /^W\. /.test(line)).map((line) => {
    const at = line.indexOf(' account=');
    const fields = line.slice(at);
    return {
      name: line.slice(3, at),
      tenant: token(fields, 'tenant'),
      role: line.slice(line.lastIndexOf(' role=') + ' role='.length),
      isNew: token(fields, 'new') === 'yes',
    };
  });
}

// Splits "<short> (<label>), <k> sessions…" by walking back from the label's closing parenthesis.
function describePlace(body) {
  const end = body.search(LABEL_END);
  if (end !== -1) {
    let depth = 0;
    for (let i = end; i >= 0; i -= 1) {
      if (body[i] === ')') depth += 1;
      if (body[i] === '(') depth -= 1;
      if (depth === 0) return { short: body.slice(0, i).replace(/ $/, ''), label: body.slice(i + 1, end) };
    }
  }
  const plain = PLAIN_PLACE.exec(body);
  return { short: plain ? plain[1] : body, label: null };
}

export function parsePlaces(text, letter) {
  const head = new RegExp(`^${letter}\\d+\\. `);
  return outputLines(text).filter((line) => head.test(line)).map((line) => {
    const at = line.indexOf(' account=');
    const fields = line.slice(at);
    const matchFrom = fields.indexOf(' match=') + ' match='.length;
    const nowAt = letter === 'J' ? fields.lastIndexOf(' now=') : -1;
    const place = describePlace(line.slice(0, at).replace(head, ''));
    const whereAt = line.indexOf(', now: ');
    return {
      kind: token(fields, 'kind'),
      match: fields.slice(matchFrom, nowAt > matchFrom ? nowAt : fields.length),
      short: place.short,
      label: place.label,
      where: letter === 'J' && whereAt !== -1 && whereAt < at ? line.slice(whereAt + ', now: '.length, at) : null,
    };
  });
}

export function placeQuestion(place, i, n) {
  const folder = place.label !== null ? place.label : place.match;
  let subject = place.short;
  if (place.kind === 'outside') subject = 'sessions outside a project folder';
  if (place.kind === 'folder') subject = `${folder} (and everything inside it)`;
  return `(${i} of ${n}) Where should analytics for ${subject} go?`;
}

export function workspaceOptions(workspaces) {
  return workspaces.map((w) => ({
    label: w.name,
    description: `${w.role || 'Beezi workspace'}${w.isNew ? ', new' : ''}`,
  }));
}

export function placeOptions(place, workspaces) {
  const nothing = place.kind === 'outside'
    ? 'Nothing from sessions outside a project folder is uploaded'
    : `Nothing from ${place.short} is uploaded`;
  return workspaceOptions(workspaces).concat([{ label: DONT_TRACK[place.kind], description: nothing }]);
}

export function tenantsArg(picked, workspaces) {
  if (picked.indexOf(workspaces.length) !== -1) return 'none';
  return picked.map((i) => workspaces[i].tenant).join(',');
}

export function ruleArgv(place, key, tenants) {
  const target = place.kind === 'outside' ? ['--outside'] : [`--${place.kind}`, place.match];
  return ['rule', 'add'].concat(target, ['--account', key, tenants, DEFER]);
}

async function runAndReport(ctx, argv) {
  report(ctx, await ctx.run('workspace.mjs', argv));
}

export async function askNewFolders(ctx, key) {
  const listing = await ctx.run('workspace.mjs', ['new-folders', '--account', key]);
  if (listing.code !== 0) {
    report(ctx, listing);
    return;
  }
  const last = lastLine(listing.stdout, /^new-folders=/);
  if (last === null || token(last, 'set') !== 'no') return;
  const choice = await ctx.ask.choose('Where should analytics go for repos and folders with no rule yet?', NEW_FOLDER_OPTIONS, { defaultIndex: 0 });
  if (choice === 0) await runAndReport(ctx, ['new-folders', 'ask', '--account', key, DEFER]);
  if (choice === 2) await runAndReport(ctx, ['new-folders', 'none', '--account', key, DEFER]);
  if (choice !== 1) return;
  const workspaces = parseWorkspaces(listing.stdout);
  const picked = await ctx.ask.chooseMany('Which workspaces should get analytics for repos and folders with no rule?', workspaceOptions(workspaces));
  if (picked === null || picked.length === 0) return;
  await runAndReport(ctx, ['new-folders', 'send', tenantsArg(picked, workspaces), '--account', key, DEFER]);
}

// One question per place; true when the last place got an answer.
async function askPerPlace(ctx, key, places, workspaces) {
  let lastAnswered = false;
  for (let i = 0; i < places.length; i += 1) {
    const picked = await ctx.ask.chooseMany(placeQuestion(places[i], i + 1, places.length), placeOptions(places[i], workspaces));
    lastAnswered = picked !== null && picked.length > 0;
    if (lastAnswered) await runAndReport(ctx, ruleArgv(places[i], key, tenantsArg(picked, workspaces)));
  }
  return lastAnswered;
}

function joinedNames(text, workspaces) {
  const found = JOINED_NAMES.exec(outputLines(text).join('\n'));
  if (found) return found[1];
  return workspaces.filter((w) => w.isNew).map((w) => w.name).join(', ');
}

// One multi-select per screen of up to 4 places; each picked place extends to this tenant via `joined pick`. False when a screen is dismissed.
async function askReposForTenant(ctx, key, tenant, places) {
  const name = tenant.name ? tenant.name : tenant.tenant;
  const parts = Math.ceil(places.length / 4);
  for (let i = 0; i < places.length; i += 4) {
    const batch = places.slice(i, i + 4);
    const part = parts > 1 ? ` (part ${i / 4 + 1} of ${parts})` : '';
    const options = batch.map((p) => ({ label: p.short, description: p.where === 'no rule yet' ? 'No rule yet' : `Now: ${p.where}` }));
    const picked = await ctx.ask.chooseMany(`Which repos and folders should also send analytics to ${name}?${CONSENT}${part}`, options);
    if (picked === null) return false;
    for (let j = 0; j < picked.length; j += 1) {
      const place = batch[picked[j]];
      const target = place.kind === 'outside' ? ['--outside'] : [`--${place.kind}`, place.match];
      await runAndReport(ctx, ['joined', 'pick'].concat(target, ['--account', key, tenant.tenant, DEFER]));
    }
  }
  return true;
}

export async function reviewJoined(ctx, key) {
  const listing = await ctx.run('workspace.mjs', ['joined', '--account', key]);
  if (listing.code !== 0) {
    report(ctx, listing);
    return;
  }
  const places = parsePlaces(listing.stdout, 'J');
  if (places.length === 0) return;
  const workspaces = parseWorkspaces(listing.stdout);
  const newTenants = workspaces.filter((w) => w.isNew);
  if (places.length > 4) {
    const names = joinedNames(listing.stdout, workspaces);
    const n = places.length;
    const choice = await ctx.ask.choose(`You joined ${names}. Where should analytics for these ${n} repos and folders go?${CONSENT}`, [
      { label: `Add ${names} to all ${n}`, description: "Repos you don't track, and ones with no rule yet, stay as they are" },
      { label: 'Choose repos', description: 'Pick which repos and folders go to each new workspace' },
      { label: 'Leave them as they are', description: `Nothing changes, and you're not asked about ${names} again` },
    ]);
    if (choice === 0) { await runAndReport(ctx, ['joined', 'add-all', '--account', key, DEFER]); return; }
    if (choice === 2) { await runAndReport(ctx, ['joined', 'done', '--account', key, DEFER]); return; }
    if (choice !== 1) return;
  }
  for (let i = 0; i < newTenants.length; i += 1) if (!(await askReposForTenant(ctx, key, newTenants[i], places))) return;
  await runAndReport(ctx, ['joined', 'done', '--account', key, DEFER]);
}

export async function reviewRoutes(ctx, key) {
  const listing = await ctx.run('workspace.mjs', ['routes', '--account', key]);
  if (listing.code !== 0) {
    report(ctx, listing);
    return;
  }
  const noFolder = lastLine(listing.stdout, NO_FOLDER);
  if (noFolder !== null) ctx.print(noFolder);
  const places = parsePlaces(listing.stdout, 'P');
  if (places.length === 0) return;
  const workspaces = parseWorkspaces(listing.stdout);
  if (places.length > 4) {
    const n = places.length;
    const choice = await ctx.ask.choose(`Where should analytics for these ${n} repos and folders go?`, [
      { label: `Send all ${n} to the same workspaces…`, description: 'Pick the workspaces once for all of them' },
      { label: 'Choose per repo', description: 'One question per repo or folder' },
      { label: 'Skip', description: "Nothing from them is sent this time; you're asked again next time" },
    ]);
    if (choice === 0) {
      const picked = await ctx.ask.chooseMany(`Which workspaces should get analytics for these ${n} repos and folders?`, workspaceOptions(workspaces));
      if (picked !== null && picked.length > 0) {
        await runAndReport(ctx, ['rule', 'add-all', '--account', key, tenantsArg(picked, workspaces), DEFER]);
      }
    }
    if (choice !== 1) return;
  }
  await askPerPlace(ctx, key, places, workspaces);
}
