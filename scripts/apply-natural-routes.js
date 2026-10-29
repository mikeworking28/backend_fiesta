const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');
const file = path.join(process.cwd(), 'src', 'services', 'agent', 'routes.ts');
const NAMES = [
  'greeting', 'postActionAcknowledgement', 'deferral', 'businessIntroduction', 'aboutBusiness',
  'additions', 'addonRequest', 'addonListFollowUp', 'addonAdvice',
];

if (!fs.existsSync(file)) {
  console.log('[MISS] routes.ts not found at ' + file + ' (run from the backend folder)');
  process.exit(1);
}
const raw = fs.readFileSync(file, 'utf8');
const crlf = raw.includes('\r\n');
let text = raw.replace(/\r\n/g, '\n');
const report = [];

for (const name of NAMES) {
  const re = new RegExp("name: '" + name + "',(\\s*replyMode: '(?:deterministic|natural)',)?", 'g');
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) { report.push(['MISS', name, 'route not found']); continue; }
  if (matches.length > 1) { report.push(['MISS', name, 'appears more than once, left alone']); continue; }
  const m = matches[0];
  if (m[1] && /natural/.test(m[1])) { report.push(['SKIP', name, 'already natural']); continue; }
  const lineStart = text.lastIndexOf('\n', m.index) + 1;
  const lead = text.slice(lineStart, m.index);
  const indent = /^\s*$/.test(lead) ? lead : '      ';
  const replacement = "name: '" + name + "',\n" + indent + "replyMode: 'natural',";
  text = text.slice(0, m.index) + replacement + text.slice(m.index + m[0].length);
  report.push(['OK', name, m[1] ? 'deterministic -> natural' : 'now natural (was unlabelled)']);
}

if (!DRY && report.some((r) => r[0] === 'OK')) {
  const backup = file + '.bak-natural';
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw);
  fs.writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text);
}
console.log('\n' + (DRY ? 'DRY RUN (nothing written)' : 'APPLIED') + '\n');
for (const [s, n, note] of report) console.log('[' + s.padEnd(4) + '] ' + n.padEnd(28) + note);
console.log('\nRollback: set AI_ASSISTANT_NATURAL_MODE=false, or restore routes.ts.bak-natural.\n');