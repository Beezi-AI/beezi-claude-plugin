import path from 'node:path';

// A string's line count, tolerating one trailing newline. Empty/undefined → 0.
function lineCount(s) {
  if (!s) return 0;
  return s.replace(/\n$/, '').split('\n').length;
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

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
    const content = line?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use' || !EDIT_TOOLS.has(block.name)) continue;
      const input = block.input || {};
      const filePath = input.file_path || input.notebook_path || null;
      touch(filePath);

      if (block.name === 'Edit') {
        linesRemoved += lineCount(input.old_string);
        linesAdded += lineCount(input.new_string);
      } else if (block.name === 'MultiEdit') {
        for (const e of input.edits || []) {
          linesRemoved += lineCount(e.old_string);
          linesAdded += lineCount(e.new_string);
        }
      } else if (block.name === 'Write') {
        linesAdded += lineCount(input.content);
      } else if (block.name === 'NotebookEdit') {
        // NotebookEdit input has no old_source; count new cell source as added only.
        linesAdded += lineCount(input.new_source);
      }
    }
  }

  const byExtension = {};
  for (const [ext, set] of filesByExt) byExtension[ext] = set.size;

  return { files_changed: files.size, lines_added: linesAdded, lines_removed: linesRemoved, by_extension: byExtension };
}
