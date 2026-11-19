import path from 'path';
import { EDIT_TOOLS } from './transcript-reader.mjs';

function extOf(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return ext || '(none)';
}

// Derive code-change stats from the tool_use blocks in a segment's transcript lines.
export function computeCodeChanges(lines) {
  const filesByExt = new Map(); // ext -> Set<file_path>
  const files = new Set();
  let linesAdded = 0;
  let linesRemoved = 0;

  const touch = (filePath) => {
    if (!filePath) return;
    files.add(filePath);
    const ext = extOf(filePath);
    let set = filesByExt.get(ext);
    if (!set) { set = new Set(); filesByExt.set(ext, set); }
    set.add(filePath);
  };

  for (const line of lines) {
    const message = line == null ? undefined : line.message;
    const content = message == null ? undefined : message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block == null || block.type !== 'tool_use' || !EDIT_TOOLS.has(block.name)) continue;
      const input = block.input || {};
      const filePath = input.file_path || input.notebook_path || null;
      touch(filePath);

      const { added, removed } = block.editLines || { added: 0, removed: 0 };
      linesAdded += added;
      linesRemoved += removed;
    }
  }

  const byExtension = {};
  for (const [ext, set] of filesByExt) byExtension[ext] = set.size;

  return { files_changed: files.size, lines_added: linesAdded, lines_removed: linesRemoved, by_extension: byExtension };
}
