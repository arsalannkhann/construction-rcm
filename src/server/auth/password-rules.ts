/**
 * The password rule, used everywhere a password is chosen: sign-up, accepting
 * an invitation, changing a password and resetting one. Pure, with no server
 * dependencies, so forms can run the same check before submitting.
 *
 * Length is the rule. Character classes are deliberately not required: they
 * push people towards "Password1!" and away from a long phrase. On top of the
 * length, the passwords that attackers try first are refused, and so is a
 * password that is just the account's own email address or name.
 *
 * The rule applies when a password is chosen. Passwords that already exist are
 * verified as they are, so existing accounts keep working.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
export const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters. Not a common password, and not your name or email address.`;

/** Passwords of ten characters or more that head the lists used for guessing. Compared in lower case with spaces removed. */
const COMMON_PASSWORDS = new Set([
  '0000000000',
  '0123456789',
  '0987654321',
  '1111111111',
  '1122334455',
  '1212121212',
  '1231231234',
  '123123123123',
  '1234512345',
  '1234567890',
  '12345678910',
  '123456789a',
  '1234567890a',
  '1234567890q',
  '123456789abc',
  '1q2w3e4r5t',
  '1q2w3e4r5t6y',
  '1qaz2wsx3edc',
  '9876543210',
  'abc1234567',
  'abcd123456',
  'abcdefghij',
  'abcdefghijk',
  'adminadmin',
  'admin12345',
  'admin123456',
  'administrator',
  'asdfghjkl1',
  'asdfghjkl123',
  'baseball123',
  'changeme123',
  'changemenow',
  'construction',
  'construction1',
  'construction123',
  'correcthorsebatterystaple',
  'football123',
  'iloveyou12',
  'iloveyou123',
  'letmein123',
  'letmein1234',
  'letmeinletmein',
  'p@ssw0rd123',
  'p@ssword123',
  'passw0rd123',
  'password10',
  'password12',
  'password123',
  'password1234',
  'password12345',
  'password123!',
  'password!23',
  'passwordpassword',
  'princess123',
  'qazwsxedcrfv',
  'qwerty12345',
  'qwerty123456',
  'qwertyqwerty',
  'qwertyuiop',
  'qwertyuiop123',
  'sunshine123',
  'superman123',
  'trustno1trustno1',
  'welcome123',
  'welcome1234',
  'welcome12345',
  'zxcvbnm123',
  'zxcvbnmasdfghjkl',
]);

const squash = (text: string) => text.toLowerCase().replace(/\s+/g, '');

/** Why this password cannot be used, or null if it can. `account` is who it is for. */
export function passwordProblem(password: string, account: { email?: string | null; name?: string | null } = {}): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return 'That password is too long.';
  const candidate = squash(password);
  // One character repeated ("aaaaaaaaaa") is as guessable as anything on the list.
  if (COMMON_PASSWORDS.has(candidate) || /^(.)\1*$/.test(candidate)) return 'That password is one of the most commonly used. Choose one that is harder to guess.';
  const own = [account.email, account.name].filter((v): v is string => !!v && v.trim().length > 0).map(squash);
  if (own.includes(candidate)) return 'Do not use your email address or your name as your password.';
  return null;
}
