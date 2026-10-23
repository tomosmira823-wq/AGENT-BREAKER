// Writes API keys into the .env text. Pure so it can be tested without Electron.
// A blank value leaves the existing line alone, so re-saving the dialog never wipes a key.
export const KEY_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];

export function mergeKeys(text, keys = {}) {
  const lines = text ? text.split('\n') : [];
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  for (const name of KEY_NAMES) {
    const v = String(keys[name] ?? '').trim();
    if (!v) continue;
    if (/[\r\n]/.test(v)) throw new Error(`${name} must be one line`);
    const line = `${name}=${v}`;
    const i = lines.findIndex((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
  }
  return lines.join('\n') + '\n';
}
