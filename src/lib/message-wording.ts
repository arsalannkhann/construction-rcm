// Shared by the server, which enforces it, and the message dialog, which warns as you type.
const IMPLIES_APPROVAL = [/\b(has|have) been approved\b/i, /\b(is|was|are|were) approved\b/i, /\bapproved for payment\b/i, /\bwe(?:'ve| have)? approved\b/i];
const IMPLIES_PAYMENT = [
  /\bpayment (has been|was|is being|will be) (sent|issued|released|made|processed|mailed|wired)\b/i,
  /\b(has|have) been paid\b/i,
  /\bwe(?:'ve| have)? paid\b/i,
  /\b(check|cheque|ach|wire|funds) (has been|have been|was|were|is being|will be) (sent|issued|mailed|released|wired)\b/i,
];

/**
 * A message to a subcontractor must not say more than is true. This product
 * records approvals; it does not issue or track payments. Returns the problem
 * with the wording, if any: `block` cannot be sent, `confirm` needs the sender
 * to vouch for it.
 */
export function messageWordingProblem(status: string, text: string): { level: 'block' | 'confirm'; reason: string } | null {
  const approval = IMPLIES_APPROVAL.some((re) => re.test(text));
  const payment = IMPLIES_PAYMENT.some((re) => re.test(text));
  if (status !== 'approved' && (approval || payment)) {
    return {
      level: 'block',
      reason: `This application has not been approved, but the message reads as if it has been ${payment ? 'paid' : 'approved'}. Reword it, or approve the application first.`,
    };
  }
  if (payment) {
    return {
      level: 'confirm',
      reason: 'The message says a payment has been or will be made. Construction RCM records approvals; it does not issue or track payments. Confirm it in your accounting system, then tick the box to send.',
    };
  }
  return null;
}
