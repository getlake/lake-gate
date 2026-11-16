import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { safeParseConfig, parseConfig, withLastValid } from './config-core.js';

export { DEFAULT_CONFIG, merge, parseConfig, safeParseConfig, ConfigError, configWarning, withLastValid, STRICT_FALLBACK } from './config-core.js';

const execGit = (root, args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const gitShow = (root, spec) => execGit(root, ['show', spec]);

// Never throws on a broken file and never loosens the policy: the last committed valid version applies
// (git history of the file on this branch); without one, a strict fallback (auto-approve off). configError explains.
export function loadConfig(root, { strict = false } = {}) {
  const p = path.join(root, '.lake', 'config.json');
  const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  if (strict) return parseConfig(text);
  const c = safeParseConfig(text);
  if (!c.configError) return c;
  // Newest first: the committed file, then its history on this branch (a broken commit is skipped).
  const shas = (execGit(root, ['log', '--format=%h', '-n', '10', 'HEAD', '--', '.lake/config.json']) || '').split('\n').filter(Boolean);
  for (const sha of shas) {
    const r = withLastValid(c, gitShow(root, `${sha}:.lake/config.json`), `commit ${sha}`);
    if (r.policyFrom) return r;
  }
  return c;
}
