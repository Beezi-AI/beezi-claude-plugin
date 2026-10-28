import fs from 'fs';
import { fileURLToPath } from 'url';
import { aboutPlugin } from '../lib/about.mjs';
import { readLocalPlugin } from '../lib/update-check.mjs';
import { isEntryScript } from '../lib/entry-script.mjs';

const NOTES_PATH = fileURLToPath(new URL('../RELEASE_NOTES.md', import.meta.url));
const HEADING = /^## (\S+) \((\d{4}-\d{2}-\d{2})\) — (.+)$/;
const SECTION = /^### (.+)$/;
const VERSION_ARG = /^\d+(\.\d+)+$/;
const EARLIER_COUNT = 3;
const KNOWN_COUNT = 5;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Rendered in this order, each under its icon; a section the file doesn't name keeps its own text.
const SECTIONS = [['New', '✨'], ['Improved', '⚡'], ['Fixed', '🐛']];
const DEFAULT_SECTION = 'Improved';
const HINT = '*Every release: `/beezi:release-notes all` · one release: `/beezi:release-notes <version>`*';

export const USAGE = 'Usage: release-notes.mjs [all | <version>]';

// [{ version, date, title, sections: [{ name, bullets }] }], in file order; bullets before any `###` go under Improved.
export function parseNotes(text) {
  const entries = [];
  let section = null;
  text.split(/\r?\n/).forEach((line) => {
    const heading = HEADING.exec(line);
    if (heading != null) {
      entries.push({ version: heading[1], date: heading[2], title: heading[3].trim(), sections: [] });
      section = null;
      return;
    }
    const entry = entries[entries.length - 1];
    if (entry == null) return;
    const named = SECTION.exec(line);
    if (named != null) {
      section = { name: named[1].trim(), bullets: [] };
      entry.sections.push(section);
    } else if (line.startsWith('- ')) {
      if (section == null) {
        section = { name: DEFAULT_SECTION, bullets: [] };
        entry.sections.push(section);
      }
      section.bullets.push(line.slice(2).trim());
    }
  });
  return entries;
}

export function bulletsOf(entry) {
  return entry.sections.reduce((all, s) => all.concat(s.bullets), []);
}

function longDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

function shortDate(date) {
  const [, month, day] = date.split('-').map(Number);
  return `${MONTHS[month - 1].slice(0, 3)} ${day}`;
}

function sectionTitle(name) {
  const known = SECTIONS.find(([n]) => n === name);
  return known == null ? name : `${known[1]} ${name}`;
}

// The entry's sections in New, Improved, Fixed order, then any others as written.
function sectionLines(entry) {
  const rank = (s) => {
    const at = SECTIONS.findIndex(([n]) => n === s.name);
    return at === -1 ? SECTIONS.length : at;
  };
  const out = [];
  entry.sections.filter((s) => s.bullets.length > 0).sort((a, b) => rank(a) - rank(b)).forEach((s) => {
    out.push('', `### ${sectionTitle(s.name)}`, ...s.bullets.map((b) => `- ${b}`));
  });
  return out;
}

// One release on its own: the version as the heading, its title, the date (and `installed`), then its sections.
function entryPage(entry, installed) {
  const when = `*Released ${longDate(entry.date)}${entry.version === installed ? ' · installed on this machine' : ''}*`;
  return [`# ✦ Beezi ${entry.version}`, `**${entry.title}**`, when, ...sectionLines(entry)];
}

export function updateLine(info) {
  if (info == null || info.status !== 'update' || info.latest == null) return null;
  return `> **Update available** — ${info.latest.version} is out. Run \`/plugin\` to update, then restart Claude Code.`;
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|');
}

function earlierTable(entries) {
  return [
    '### Earlier releases',
    '| Version | Date | What changed |',
    '|---|---|---|',
    ...entries.map((e) => `| **${e.version}** | ${shortDate(e.date)} | ${cell(e.title)} |`),
  ];
}

export function formatCurrent(entries, installed, info) {
  const out = [];
  const update = updateLine(info);
  if (update != null) out.push(update, '');
  let at = entries.findIndex((e) => e.version === installed);
  if (at === -1) {
    at = 0;
    out.push(`> No notes for ${installed || 'this build'} yet, so these are the newest.`, '');
  }
  out.push(...entryPage(entries[at], installed));
  const earlier = entries.slice(at + 1, at + 1 + EARLIER_COUNT);
  out.push('', '---', '');
  if (earlier.length > 0) out.push(...earlierTable(earlier), '');
  out.push(HINT);
  return `${out.join('\n')}\n`;
}

export function formatAll(entries, installed = null) {
  const out = ['# ✦ Beezi release notes'];
  entries.forEach((e, i) => {
    if (i > 0) out.push('', '---');
    const mark = e.version === installed ? ' · installed' : '';
    out.push('', `## ${e.version} — ${e.title}`, `*${longDate(e.date)}${mark}*`, ...sectionLines(e));
  });
  return `${out.join('\n')}\n`;
}

export function formatVersion(entries, version, installed = null) {
  const entry = entries.find((e) => e.version === version);
  if (entry != null) return `${[...entryPage(entry, installed), '', '---', '', HINT].join('\n')}\n`;
  const known = entries.slice(0, KNOWN_COUNT).map((e) => `\`${e.version}\``).join(', ');
  return `> No release notes for **${version}**. The newest are ${known} — see \`/beezi:release-notes all\`.\n`;
}

function installedVersion(info, deps) {
  const local = info != null && info.local != null ? info.local : readLocalPlugin(deps);
  return local == null ? null : local.version;
}

// The update check is best-effort: any failure just drops the update line.
export async function releaseNotes(arg, deps = {}) {
  const entries = parseNotes(deps.text == null ? fs.readFileSync(NOTES_PATH, 'utf8') : deps.text);
  if (arg === 'all') return formatAll(entries, installedVersion(null, deps));
  if (arg != null) return formatVersion(entries, arg, installedVersion(null, deps));
  const about = deps.aboutPlugin == null ? aboutPlugin : deps.aboutPlugin;
  let info = null;
  try {
    info = await about();
  } catch { /* offline or unreadable: no update line */ }
  return formatCurrent(entries, installedVersion(info, deps), info);
}

async function main() {
  const arg = process.argv[2];
  if (process.argv.length > 3 || (arg != null && arg !== 'all' && !VERSION_ARG.test(arg))) {
    console.error(USAGE);
    process.exit(1);
  }
  process.stdout.write(await releaseNotes(arg));
}

if (isEntryScript(import.meta.url)) {
  main().catch((error) => {
    console.error(`✗ Beezi: could not show the release notes (${error.message})`);
    process.exit(1);
  });
}
