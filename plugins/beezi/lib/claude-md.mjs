import fs from 'node:fs';
import path from 'node:path';

// Size of a repository's root CLAUDE.md — the standing instructions Claude Code prepends to every
// prompt run inside that repo, and so a per-repo floor on what each turn costs before the user has
// typed anything.
//
// Counted `wc -l`-style except that a final line without a trailing newline still counts, so the
// number matches what an editor shows. Returns null when the repo has no CLAUDE.md (or it can't be
// read) rather than 0 — the report omits the field entirely in that case, which keeps 0 meaning
// "present but empty" instead of collapsing the two.
//
// Only the root file. Nested CLAUDE.md files, `.claude/CLAUDE.md`, the user-global one and
// @-imports all add to the real prompt, but none of them are attributes of the repository.
export function claudeMdLines(repoRoot) {
  if (!repoRoot) return null;
  let text;
  try {
    text = fs.readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf-8');
  } catch {
    return null;
  }
  if (text === '') return 0;
  return text.replace(/\n$/, '').split('\n').length;
}
