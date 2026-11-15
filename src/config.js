import fs from 'node:fs';
import path from 'node:path';
import { parseConfig } from './config-core.js';

export { DEFAULT_CONFIG, merge, parseConfig } from './config-core.js';

export function loadConfig(root) {
  const p = path.join(root, '.lake', 'config.json');
  return parseConfig(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
}
