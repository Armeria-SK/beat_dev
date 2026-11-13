import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const LINE = /^(.*) ([0-9a-f]{40}|[0-9a-f]{64}) (\S+) ([0-9a-f]{40}|[0-9a-f]{64})$/u;
let ok = false;
try {
  const input = readFileSync(0, 'utf8');
  writeFileSync(join(dir, 'push-input'), input);
  const tips = new Set(readFileSync(join(dir, 'tips.txt'), 'utf8').split('\n').map(line => line.trim()).filter(Boolean));
  const refused = [];
  for (const raw of input.split('\n')) {
    const line = raw.replace(/\r$/u, '');
    if (line === '') continue;
    const m = LINE.exec(line);
    if (!m) { refused.push(line); continue; }
    const [, localRef, localSha] = m;
    if (/^0+$/u.test(localSha)) continue;
    if (!tips.has(localSha)) refused.push(localRef);
  }
  if (refused.length) appendFileSync(join(dir, 'refused'), `${refused.join('\n')}\n`);
  else ok = true;
} catch {
  ok = false;
}
process.exit(ok ? 0 : 1);
