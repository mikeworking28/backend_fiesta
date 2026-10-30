#!/usr/bin/env node
/**
 * apply-calendar-fixes.js
 *
 * Run from the backend folder:
 *   node scripts/apply-calendar-fixes.js --dry
 *   node scripts/apply-calendar-fixes.js
 *
 * Backs up each changed file as <file>.bak-calendar, skips anything already applied,
 * and reports [MISS] where your file differs so you can apply that one by hand.
 */
const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');
const AGENT = path.join(process.cwd(), 'src', 'services', 'agent');
const report = [];

function patchFile(name, patches) {
  const file = path.join(AGENT, name);
  if (!fs.existsSync(file)) { report.push(['MISS', name, 'file not found at ' + file]); return; }
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  let text = raw.replace(/\r\n/g, '\n');
  let changed = false;

  for (const p of patches) {
    if (p.skipIf && text.includes(p.skipIf)) { report.push(['SKIP', name, p.name + ' (already applied)']); continue; }
    let start = -1, end = -1;
    if (typeof p.find === 'string') {
      start = text.indexOf(p.find);
      if (start !== -1) {
        if (text.indexOf(p.find, start + 1) !== -1) { report.push(['MISS', name, p.name + ' (anchor appears more than once, left alone)']); continue; }
        end = start + p.find.length;
      }
    } else {
      const m = text.match(p.find);
      if (m) { start = m.index; end = start + m[0].length; }
    }
    if (start === -1) { report.push(['MISS', name, p.name + ' (anchor not found - apply by hand)']); continue; }
    text = text.slice(0, start) + p.replace(text.slice(start, end)) + text.slice(end);
    changed = true;
    report.push(['OK', name, p.name]);
  }

  if (changed && !DRY) {
    const backup = file + '.bak-calendar';
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw);
    fs.writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text);
  }
}

/* 1. slot-memory.ts: "2.30" / "2:30" with no am/pm, right after we asked for a time */
const LOOSE_TIME = [
  '  // Bare times such as "2.30" or "2:30" (no am/pm) right after we asked for a time.',
  '  // Studio hours are 9-19, so 9-11 reads as morning, 12 as noon and 1-8 as afternoon.',
  '  if (!slots.time && !question && /\\b(?:what|which) time\\b|\\btime (?:would|will) (?:suit|work)\\b|\\bpreferred time\\b/i.test(lastAssistant)) {',
  "    const loose = message.trim().match(/^(?:(?:give me|make it|let'?s (?:do|go with)|i(?:'d| would) like|i want|take|at)\\s+)?(\\d{1,2})\\s*[.:]\\s*(\\d{2})[.!]*$/i);",
  '    if (loose) {',
  '      const rawHour = Number(loose[1]);',
  '      const minute = Number(loose[2]);',
  '      if (rawHour >= 1 && rawHour <= 12 && minute < 60) {',
  '        const hour = rawHour >= 9 && rawHour <= 11 ? rawHour : rawHour === 12 ? 12 : rawHour + 12;',
  "        slots.time = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');",
  '      }',
  '    }',
  '  }',
  '  return { slots, invalidDate };',
].join('\n');

patchFile('slot-memory.ts', [
  {
    name: 'parse bare times like 2.30 after a time question',
    skipIf: 'Bare times such as',
    find: '  return { slots, invalidDate };',
    replace: () => LOOSE_TIME,
  },
]);

/* 2 + 3 + 4. agent.service.ts */
const FOLLOW_UP = [
  'try {',
  '        // When the calendar answer is already built in code, a second model call only costs',
  '        // tokens (and can hit a rate limit or provider error) without changing what she sees.',
  '        if (calendarReply && !proposedThisTurn && !confirmedActionThisTurn) break;',
  '        completion = await this.createCompletionWithToolNameGuard({',
  '          ...completionParams,',
  '          messages,',
  '        }, allowedToolNames, availableTools, completion.provider);',
  '      } catch (followUpError) {',
  '        if (!(calendarReply || exactProposalReply || cancellationReply)) throw followUpError;',
  "        console.warn('[AGENT_FLOW] follow-up model call failed; replying with the code-built answer.');",
  '        break;',
  '      }',
  '      currentResponse = completion.response;',
].join('\n');

const EDITION_KEY = "const editionKey = (value: unknown) => String(value || '').toLowerCase().replace(/^the\\s+/, '').replace(/\\s+(?:edition|package)$/, '').trim();";
const EDITION_ERROR = "toolResponse = 'ERROR: The stored package for this booking is ' + knownService + ', but you asked about ' + args.service + '. Do not check availability yet; ask her warmly which edition she would like, then continue.';";

patchFile('agent.service.ts', [
  {
    name: 'skip redundant follow-up call + survive provider errors when the reply is code-built',
    skipIf: 'follow-up model call failed',
    find: /completion = await this\.createCompletionWithToolNameGuard\(\{\s*\.\.\.completionParams,\s*messages,\s*\},\s*allowedToolNames,\s*availableTools,\s*completion\.provider\);\s*currentResponse = completion\.response;/,
    replace: () => FOLLOW_UP,
  },
  {
    name: 'ask which edition when the model and the stored draft disagree (dates)',
    skipIf: 'edition-guard-dates',
    find: 'toolResponse = JSON.stringify(await checkDateRange(range.fromDate, range.toDate, knownService || args.service));',
    replace: (o) => [
      '// edition-guard-dates',
      EDITION_KEY,
      '              if (knownService && args.service && !statedSlots.service && editionKey(knownService) !== editionKey(args.service)) {',
      '                ' + EDITION_ERROR,
      '              } else {',
      '                ' + o,
      '              }',
    ].join('\n'),
  },
  {
    name: 'ask which edition when the model and the stored draft disagree (slots)',
    skipIf: 'edition-guard-slots',
    find: 'toolResponse = JSON.stringify(await checkCalendarSlots(requestedDate, knownService || args.service));',
    replace: (o) => [
      '// edition-guard-slots',
      EDITION_KEY,
      '              if (knownService && args.service && !statedSlots.service && editionKey(knownService) !== editionKey(args.service)) {',
      '                ' + EDITION_ERROR,
      '              } else {',
      '                ' + o,
      '              }',
      ].join('\n'),
  },
  {
    name: 'D0: interest is not a booking request; ask when a request is ambiguous',
    skipIf: 'that seems interesting',
    find: 'Vary your wording so you never sound like a template. Warm and gracious, never gushing, never curt.',
    replace: (o) => o + ' Interest ("that seems interesting", "I like it") is not a booking request: respond to it warmly and let her lead, offering to help her choose or answer questions rather than asking for a date. If a request is ambiguous (for example "suggest for me"), ask one short question about what she would like suggested instead of assuming a booking. Never open a reply with her name alone. In sentences write edition names as "the Muse" or "the Bloom", not in capitals.',
  },
]);

console.log('\n' + (DRY ? 'DRY RUN (nothing written)' : 'APPLIED') + '\n');
for (const [s, f, n] of report) console.log('[' + s.padEnd(4) + '] ' + f.padEnd(18) + n);
const missed = report.filter((r) => r[0] === 'MISS').length;
console.log('\n' + report.filter((r) => r[0] === 'OK').length + ' patched, ' + report.filter((r) => r[0] === 'SKIP').length + ' already applied, ' + missed + ' need a manual look.');
console.log('Next: npx tsc --noEmit   then restart and retest.\n');
process.exit(missed ? 1 : 0);