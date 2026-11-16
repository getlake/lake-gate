import fs from 'node:fs';
import path from 'node:path';
import { safeParseConfig, parseConfig } from './config-core.js';

export { DEFAULT_CONFIG, merge, parseConfig, safeParseConfig, ConfigError } from './config-core.js';

// Never throws on a broken file: defaults apply and config.configError explains (file, line, column).
export function loadConfig(root, { strict = false } = {}) {
  const p = path.join(root, '.lake', 'config.json');
  const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  return strict ? parseConfig(text) : safeParseConfig(text);
}
