// Server-supplied names reach model-read lines, so control characters and line breaks collapse to one space.
export function oneLine(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return text === '' ? null : text;
}
