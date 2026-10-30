#!/usr/bin/env node
/**
 * apply-till-flow.js - removes the M-Pesa STK push from the booking flow and moves it to
 * "pay to the Till, then send your M-Pesa message".
 *
 * Run from the backend folder:
 *   node scripts/apply-till-flow.js --dry
 *   node scripts/apply-till-flow.js
 *
 * Each changed file is backed up as <file>.bak-till. Patches whose anchor is not found are
 * reported as [MISS] and left alone, so apply those by hand.
 */
const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');
const AGENT = path.join(process.cwd(), 'src', 'services', 'agent');
const SRC = path.join(process.cwd(), 'src');
const report = [];

function patchFile(file, label, patches) {
  if (!fs.existsSync(file)) { report.push(['MISS', label, 'file not found at ' + file]); return; }
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  let text = raw.replace(/\r\n/g, '\n');
  let changed = false;
  for (const p of patches) {
    if (p.skipIf && text.includes(p.skipIf)) { report.push(['SKIP', label, p.name + ' (already applied)']); continue; }
    let start = -1, end = -1;
    if (typeof p.find === 'string') {
      start = text.indexOf(p.find);
      if (start !== -1) {
        if (text.indexOf(p.find, start + 1) !== -1) { report.push(['MISS', label, p.name + ' (anchor appears more than once)']); continue; }
        end = start + p.find.length;
      }
    } else {
      const m = text.match(p.find);
      if (m) { start = m.index; end = start + m[0].length; }
    }
    if (start === -1) { report.push(['MISS', label, p.name + ' (anchor not found - apply by hand)']); continue; }
    text = text.slice(0, start) + p.replace(text.slice(start, end)) + text.slice(end);
    changed = true;
    report.push(['OK', label, p.name]);
  }
  if (changed && !DRY) {
    const backup = file + '.bak-till';
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw);
    fs.writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text);
  }
}

/* ---------- new file: till-payment.ts ---------- */
const TILL_MODULE = "/**\n * Till (Buy Goods) payment settings and helpers.\n * The customer pays outside the chat, then sends her M-Pesa message or transaction code.\n * Nothing is ever pushed to her phone.\n */\nexport const TILL_NUMBER = process.env.MPESA_TILL_NUMBER?.trim() || '670241';\nexport const TILL_NAME = process.env.MPESA_TILL_NAME?.trim() || 'Fiesta House Maternity';\n\n/**\n * While her draft waits for the M-Pesa message, only these routes may answer;\n * everything else is left to the model so a pasted message is never hijacked\n * by an invoice, date or fact route.\n */\nexport const PAYMENT_MESSAGE_ROUTES = new Set([\n  'runAgent',\n  'cancellationProposal',\n  'cancellationDeclined',\n  'staleCancellationProposal',\n  'bookingStatus',\n  'customerName',\n]);\n\nexport type ParsedMpesaMessage = {\n  code: string | null;\n  amount: number | null;\n  recipient: string | null;\n  paidOn: string | null;\n  paidAt: string | null;\n};\n\n// M-Pesa transaction codes are 10 characters mixing letters and digits, e.g. UJK3L9ABCD.\nconst CODE_PATTERN = /\\b(?=[A-Z0-9]*\\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10}\\b/i;\n\n/** Reads what it can from a pasted M-Pesa confirmation, or from a bare transaction code. */\nexport function parseMpesaMessage(text: string): ParsedMpesaMessage {\n  const message = String(text || '');\n  const code = message.match(CODE_PATTERN)?.[0]?.toUpperCase() ?? null;\n  const amountMatch = message.match(/\\bKsh\\.?\\s*([\\d,]+(?:\\.\\d{1,2})?)/i);\n  const amount = amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : null;\n  const recipient = message.match(/\\b(?:paid|sent) to\\s+([A-Za-z0-9&' -]+?)(?:\\.|\\s+on\\s|\\s+\\d{9,}|\\s+for account|$)/i)?.[1]?.trim() ?? null;\n  const when = message.match(/\\bon\\s+(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})\\s+at\\s+(\\d{1,2}:\\d{2}\\s*[AP]M)/i);\n  return {\n    code,\n    amount: amount !== null && Number.isFinite(amount) ? amount : null,\n    recipient,\n    paidOn: when?.[1] ?? null,\n    paidAt: when?.[2]?.toUpperCase() ?? null,\n  };\n}\n";
const tillFile = path.join(AGENT, 'till-payment.ts');
if (fs.existsSync(tillFile)) report.push(['SKIP', 'till-payment.ts', 'file already exists']);
else {
  if (!DRY) fs.writeFileSync(tillFile, TILL_MODULE);
  report.push(['OK', 'till-payment.ts', 'created (Till number, route allow-list, M-Pesa message parser)']);
}

/* ---------- booking-tools.ts ---------- */
const NEW_CONFIRM = [
  'export async function executeConfirmBookingTool(',
  '  this: any,',
  '  customerId: string,',
  '  initialDraftStep: string | undefined,',
  '  expectedDeposit: number | null',
  ') {',
  '  // Till flow: she is told how to pay, then sends her M-Pesa message. Nothing is pushed to her phone.',
  "  if (initialDraftStep === 'awaiting_payment_message') {",
  "    throw new Error('She has already confirmed and was given the payment details. Do not call confirm_booking again; wait for her M-Pesa message or transaction code.');",
  '  }',
  "  if (initialDraftStep !== 'awaiting_confirmation') {",
  "    throw new Error('No pending booking proposal from a prior message. Call propose_booking first and wait for the customer to explicitly confirm on their own next message before calling confirm_booking.');",
  '  }',
  '',
  '  const draft = await bookingDraftService.get(customerId);',
  "  if (!draft || draft.step !== 'awaiting_confirmation') {",
  "    throw new Error('No pending booking proposal found. Call propose_booking first.');",
  '  }',
  '',
  '  const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => draft.service?.toLowerCase().includes(key));',
  '  if (!serviceKey) {',
  "    throw new Error('The pending booking\\'s package \"' + (draft.service || 'unknown') + '\" isn\\'t recognised, so the deposit can\\'t be worked out. Do not share payment details; ask the studio team to check the package.');",
  '  }',
  '  if (!draft.date || !draft.time) {',
  "    throw new Error('The pending booking is missing its date or time. Ask the customer to start the booking again.');",
  '  }',
  '  const slotsResult: any = await bookingService.getAvailableSlots(',
  '    draft.date,',
  '    SERVICE_DURATIONS[serviceKey],',
  '    undefined,',
  '    draft.id',
  '  );',
  "  if (slotsResult?.status === 'closed') {",
  "    throw new Error('The studio is closed on ' + draft.date + '. Do not share payment details for this booking.');",
  '  }',
  '  const availableSlots: string[] = Array.isArray(slotsResult) ? slotsResult : [];',
  '  if (!availableSlots.includes(draft.time)) {',
  "    throw new Error('The proposed time ' + draft.time + ' on ' + draft.date + ' is no longer available. Do not share payment details; ask the customer to choose another time.');",
  '  }',
  '',
  "  const depositAmount = this.getDepositForPackage(await this.getPackageForDeposit(draft.service || ''));",
  '  if (expectedDeposit === null || expectedDeposit !== depositAmount) {',
  "    throw new Error('The package deposit no longer matches the amount in the customer-visible proposal. Do not share payment details; prepare a new proposal and ask for confirmation again.');",
  '  }',
  '',
  '  // Claims the draft once: a duplicate "yes" fails the version check and does nothing.',
  '  await bookingDraftService.markAwaitingPaymentMessage(customerId, draft.version);',
  '',
  '  return {',
  '    success: true,',
  '    draftId: draft.id,',
  '    depositAmount,',
  '    service: draft.service,',
  '    date: draft.date,',
  '    time: draft.time,',
  '    till: TILL_NUMBER,',
  '    tillName: TILL_NAME,',
  '  };',
  '}',
  '',
  '',
].join('\n');

patchFile(path.join(AGENT, 'booking-tools.ts'), 'booking-tools.ts', [
  {
    name: 'replace the STK import with the Till module',
    skipIf: "from './till-payment'",
    find: "import { mpesaService } from '../payment/mpesa.service';",
    replace: () => "import { TILL_NAME, TILL_NUMBER } from './till-payment';",
  },
  {
    name: 'confirm step: record her confirmation and wait for her M-Pesa message (no STK push)',
    skipIf: 'Till flow: she is told how to pay',
    find: /export async function executeConfirmBookingTool\([\s\S]*?(?=export async function getPackageForDeposit\()/,
    replace: () => NEW_CONFIRM,
  },
]);

/* ---------- booking-draft.service.ts ---------- */
const NEW_DRAFT_METHOD = [
  '  /** Till flow: she has been told how to pay; the draft now waits for her M-Pesa message. A duplicate "yes" fails the version check. */',
  '  async markAwaitingPaymentMessage(customerId: string, version?: number) {',
  '    const versioned = Number.isInteger(version);',
  '    try {',
  '      return await prisma.bookingDraft.update({',
  "        where: { customerId, step: 'awaiting_confirmation', ...(versioned ? { version } : {}) },",
  "        data: { step: 'awaiting_payment_message', ...(versioned ? { version: Number(version) + 1 } : {}) },",
  '      });',
  '    } catch (error: any) {',
  "      if (error?.code === 'P2025') throw Object.assign(new Error('This booking is already waiting for a payment message.'), { code: 'PAYMENT_ALREADY_PENDING' });",
  '      throw error;',
  '    }',
  '  }',
  '',
  '',
].join('\n');

patchFile(path.join(AGENT, '..', 'booking', 'booking-draft.service.ts'), 'booking-draft.service.ts', [
  {
    name: 'add markAwaitingPaymentMessage',
    skipIf: 'markAwaitingPaymentMessage',
    find: '  /** Claims the draft for one STK push; a concurrent duplicate confirmation fails the version check. */',
    replace: (o) => NEW_DRAFT_METHOD + o,
  },
]);

/* ---------- booking.service.ts: hold her slot while she pays ---------- */
const NEW_HOLD = [
  'const twoHoursAgo = nowInBusinessTimezone().subtract(2, \'hour\').toDate();',
  '    const activeDrafts = await prisma.bookingDraft.findMany({',
  '      where: {',
  '        dateTimeIso: { not: null },',
  '        ...(excludeDraftId ? { id: { not: excludeDraftId } } : {}),',
  '        OR: [',
  "          { step: { in: ['awaiting_confirmation', 'payment_pending'] }, updatedAt: { gte: fifteenMinutesAgo } },",
  '          // Till flow: she pays outside the chat, so her slot stays held for up to two hours.',
  "          { step: 'awaiting_payment_message', updatedAt: { gte: twoHoursAgo } },",
  '        ],',
  '      }',
  '    });',
].join('\n');

patchFile(path.join(AGENT, '..', 'booking', 'booking.service.ts'), 'booking.service.ts', [
  {
    name: 'hold the slot for two hours while she pays',
    skipIf: 'awaiting_payment_message',
    find: /const activeDrafts = await prisma\.bookingDraft\.findMany\(\{\s*where: \{\s*step: \{ in: \['awaiting_confirmation', 'payment_pending'\] \},\s*updatedAt: \{\s*gte: fifteenMinutesAgo\s*\},\s*dateTimeIso: \{ not: null \},\s*\.\.\.\(excludeDraftId \? \{ id: \{ not: excludeDraftId \} \} : \{\}\),\s*\}\s*\}\);/,
    replace: () => NEW_HOLD,
  },
]);

/* ---------- slot-memory.ts ---------- */
patchFile(path.join(AGENT, 'slot-memory.ts'), 'slot-memory.ts', [
  {
    name: 'protect the draft while it waits for her payment message',
    skipIf: "'payment_pending', 'awaiting_payment_message'",
    find: "const PROTECTED_STEPS = ['awaiting_confirmation', 'payment_pending', 'reschedule_confirm', 'cancel_confirm'];",
    replace: () => "const PROTECTED_STEPS = ['awaiting_confirmation', 'payment_pending', 'awaiting_payment_message', 'reschedule_confirm', 'cancel_confirm'];",
  },
]);

/* ---------- constants.ts ---------- */
patchFile(path.join(AGENT, 'constants.ts'), 'constants.ts', [
  {
    name: 'no more "M-Pesa deposit prompt" wording',
    skipIf: 'share the payment details',
    find: /^export const PAYMENT_CONFIRMATION_REQUIRED_REPLY = .*$/m,
    replace: () => "export const PAYMENT_CONFIRMATION_REQUIRED_REPLY = 'Before I share the payment details, please reply yes to confirm the booking.';",
  },
]);

/* ---------- routes.ts: wording only ---------- */
patchFile(path.join(AGENT, 'routes.ts'), 'routes.ts', [
  {
    name: 'immediate-confirmation failure wording',
    skipIf: 'The studio team will help you with the deposit.',
    find: 'The studio team will help with the deposit prompt.',
    replace: () => 'The studio team will help you with the deposit.',
  },
  {
    name: 'payment-recovery failure wording',
    skipIf: 'I could not check your payment just now. The studio team',
    find: 'I could not check your payment just now, so I have not sent another prompt. The studio team',
    replace: () => 'I could not check your payment just now. The studio team',
  },
  {
    name: 'provider-outage wording',
    skipIf: 'so I have not sent a deposit proposal. A team member',
    find: 'so I have not sent a deposit proposal or M-Pesa prompt. A team member',
    replace: () => 'so I have not sent a deposit proposal. A team member',
  },
]);

/* ---------- agent.service.ts ---------- */
const IMMEDIATE_BRANCH = [
  "if (draft.step === 'awaiting_confirmation') {",
  '      if (!this.isPaymentConfirmation(userMessage)) {',
  '        return PAYMENT_CONFIRMATION_REQUIRED_REPLY;',
  '      }',
  '      const expectedDeposit = this.getDepositAmountFromProposalHistory(history);',
  '      if (expectedDeposit === null || !this.previousMessageRequestsConfirmation(history)) {',
  '        return this.getBookingStatusReply(customerId);',
  '      }',
  '      try {',
  "        await this.executeConfirmBookingTool(customerId, 'awaiting_confirmation', expectedDeposit);",
  '      } catch (error: any) {',
  '        if (error?.code !== PAYMENT_ALREADY_PENDING) throw error;',
  '      }',
  '      // Till flow: her confirmation is recorded and the draft now waits for her M-Pesa message.',
  '      // Returning null lets the model tell her, in its own words, how to pay (see the payment summary in runAgent).',
  '      return null;',
  '    }',
  '',
  "    if (draft.step === 'reschedule_confirm' && this.previousMessageRequestsConfirmation(history)) {",
].join('\n');

const CONFIRM_TOOL = [
  "toolResponse = 'SUCCESS: She has confirmed the proposal and the booking now waits for her deposit. Tell her warmly, in your own words, to pay KSh ' + result.depositAmount.toLocaleString() + ' via Lipa na M-Pesa, Buy Goods, Till Number ' + result.till + ' (' + result.tillName + '), then send you the M-Pesa message or just the transaction code. Say her session is booked once the team has verified the payment. This is DONE - do not call any more booking tools this turn.';",
].join('\n');

const PAYMENT_SUMMARY = [
  "} else if (draftBeforeThisTurn?.step === 'awaiting_payment_message') {",
  "      let depositText = 'the deposit amount in her proposal';",
  '      try {',
  "        const deposit = this.getDepositForPackage(await this.getPackageForDeposit(draftBeforeThisTurn.service || ''));",
  "        depositText = 'KSh ' + deposit.toLocaleString();",
  '      } catch {',
  '        // keep the generic wording',
  '      }',
  "      paymentSummary = 'She has confirmed her booking proposal. The deposit (' + depositText + ') is paid via Lipa na M-Pesa, Buy Goods, Till Number ' + TILL_NUMBER + ' (' + TILL_NAME + '). We are waiting for her to send the M-Pesa confirmation message or transaction code. If you have not yet told her how to pay, do so now in your own words; otherwise answer her questions. When she sends the message or code, tell her warmly that the team will verify it and confirm her session. Never say the payment is received or the booking confirmed until the team has verified it.';",
  '    }',
].join('\n');

const CAPTURE_METHOD = [
  '  /**',
  '   * Till flow. Returns true while her draft is waiting for her M-Pesa message. When the message',
  '   * (or a transaction code) arrives, the team is alerted at once with everything we could read from it.',
  '   */',
  '  private async captureMpesaMessage(customerId: string, userMessage: string, platform: string): Promise<boolean> {',
  "    if (platform !== 'whatsapp' && platform !== 'web') return false;",
  '    try {',
  '      const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });',
  "      if (draft?.step !== 'awaiting_payment_message') return false;",
  '      const parsed = parseMpesaMessage(userMessage);',
  '      if (parsed.code) {',
  "        await this.escalate(customerId, 'booking', JSON.stringify({",
  "          event: 'mpesa_payment_message_received',",
  '          ...parsed,',
  '          booking: { service: draft.service, date: draft.date, time: draft.time, name: draft.name },',
  '          customerMessage: userMessage.slice(0, 1000),',
  "          action: 'Check the transaction against the M-Pesa statement, then confirm the booking.',",
  '        }));',
  '      }',
  '      return true;',
  '    } catch (error) {',
  "      console.error('[AGENT_FLOW] Could not check for an M-Pesa message:', error);",
  '      return false;',
  '    }',
  '  }',
  '',
  '  private async escalateQuotaHandoff(',
].join('\n');

const CAPTURE_CALL = [
  '// Till flow: if she has just sent her M-Pesa message or code, hand it to the team right away,',
  '    // and keep deterministic routes from hijacking the conversation while we wait for it.',
  '    const paymentMessageMode = await this.captureMpesaMessage(customerId, userMessage, platform);',
  '',
  '    if (circuitBreaker.isOpen()) {',
].join('\n');

const PROMPT_F = 'f) Once she has confirmed, tell her warmly, in your own words, how to pay the deposit: Lipa na M-Pesa, Buy Goods, Till Number ${TILL_NUMBER} (${TILL_NAME}), for the exact deposit amount, and ask her to send you the M-Pesa message or just the transaction code afterwards. Be honest that her session is booked only once the team has verified the payment. Nothing is ever sent to her phone.\n';

patchFile(path.join(AGENT, 'agent.service.ts'), 'agent.service.ts', [
  {
    name: 'import the Till module',
    skipIf: "from './till-payment'",
    find: "import { notifyAdmin } from '../notifications/notification.service';",
    replace: (o) => o + "\nimport { TILL_NAME, TILL_NUMBER, PAYMENT_MESSAGE_ROUTES, parseMpesaMessage } from './till-payment';",
  },
  {
    name: "'yes' records her confirmation instead of sending an STK push",
    skipIf: 'Till flow: her confirmation is recorded',
    find: /if \(draft\.step === 'awaiting_confirmation'\) \{[\s\S]*?\n    \}\n\n    if \(draft\.step === 'reschedule_confirm' && this\.previousMessageRequestsConfirmation\(history\)\) \{/,
    replace: () => IMMEDIATE_BRANCH,
  },
  {
    name: 'confirm_booking tool result: payment instructions, no STK reply',
    skipIf: 'Say her session is booked once the team has verified the payment. This is DONE',
    find: /exactProposalReply = `I've initiated a deposit payment request[\s\S]*?do not call any more booking tools this turn\.`;/,
    replace: () => CONFIRM_TOOL,
  },
  {
    name: 'payment summary for the model while she is paying',
    skipIf: 'let depositText',
    find: /\} else if \(draftBeforeThisTurn\?\.step === 'payment_pending'\) \{\s*paymentSummary = '[^']*';\s*\}/,
    replace: () => PAYMENT_SUMMARY,
  },
  {
    name: 'alert the team when her M-Pesa message arrives (+ add the helper method)',
    skipIf: 'private async captureMpesaMessage',
    find: '  private async escalateQuotaHandoff(',
    replace: () => CAPTURE_METHOD,
  },
  {
    name: 'call it before the circuit-breaker check',
    skipIf: 'const paymentMessageMode',
    find: '    if (circuitBreaker.isOpen()) {',
    replace: () => '    ' + CAPTURE_CALL,
  },
  {
    name: 'payment-message mode: skip hijacking routes (before slot capture)',
    skipIf: 'till-mode:early',
    find: 'for (const route of routes.filter(candidate => candidate.beforeSlotCapture)) {',
    replace: (o) => o + '\n      if (paymentMessageMode && !PAYMENT_MESSAGE_ROUTES.has(route.name)) continue; // till-mode:early',
  },
  {
    name: 'payment-message mode: skip hijacking routes (main loop)',
    skipIf: 'till-mode:main',
    find: "if (route.name === 'scopeBoundary') continue;",
    replace: (o) => o + '\n      if (paymentMessageMode && !PAYMENT_MESSAGE_ROUTES.has(route.name)) continue; // till-mode:main',
  },
  {
    name: 'prompt B2f: how to pay (Till), in her own words',
    skipIf: 'Once she has confirmed, tell her warmly, in your own words, how to pay',
    find: /f\) After confirm_booking, instruct her to pay[^\n]*\n/,
    replace: () => PROMPT_F,
  },
]);

console.log('\n' + (DRY ? 'DRY RUN (nothing written)' : 'APPLIED') + '\n');
for (const [s, f, n] of report) console.log('[' + s.padEnd(4) + '] ' + f.padEnd(26) + n);
const missed = report.filter((r) => r[0] === 'MISS').length;
console.log('\n' + report.filter((r) => r[0] === 'OK').length + ' patched, ' + report.filter((r) => r[0] === 'SKIP').length + ' already applied, ' + missed + ' need a manual look.');
console.log('Next: npx tsc --noEmit');
console.log('Then find what is left:  Get-ChildItem -Recurse src -Filter *.ts | Select-String -Pattern "STK|stk push|initiateStkPush|payment prompt|M-Pesa prompt" | Select-Object Path,LineNumber,Line\n');
process.exit(missed ? 1 : 0);