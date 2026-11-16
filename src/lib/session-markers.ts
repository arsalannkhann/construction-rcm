/**
 * Plain, non-secret markers the browser keeps beside the real session, shared
 * by the server (which sets and clears the cookie) and the browser (the public
 * website reads it; the app records and sign-out clears the last page).
 */

/** "This browser has a Zephric session." Not HttpOnly so the website can read it; it carries no secret and grants nothing. */
export const SIGNED_IN_HINT_COOKIE = 'zephric_signed_in';

/** The last app page this browser opened: a path and a page-type label, never record contents. Cleared on sign-out. */
export const LAST_PAGE_KEY = 'zephric:last-page';
