/**
 * Procore integration — the public API the rest of the application calls.
 *
 * Built from docs/procore-api-notes.md and tested against the API emulator in
 * tests/procore.test.ts. It has not been run against a live Procore account.
 *
 *   procoreStatus      what the settings screen and the push button need to know
 *   beginConnect       start OAuth            (integrations:manage)
 *   completeConnect    finish OAuth, store encrypted tokens, pick the company if there is only one
 *   listCompanies / selectCompany
 *   disconnect         revoke if possible, forget the tokens, keep imported records
 *   listProcoreProjects / importProject      (integrations:manage + records:write)
 *   canPushToProcore / pushToProcore         (export:run)
 */
export {
  beginConnect,
  completeConnect,
  disconnect,
  listCompanies,
  procoreStatus,
  ProcoreConnectFailure,
  selectCompany,
  type ProcoreCompany,
  type ProcoreStatus,
} from './connection';
export { importProject, listProcoreProjects, type ProcoreImportResult, type ProcoreProjectListing } from './import';
export { canPushToProcore, pushToProcore, type ProcorePushAvailability, type ProcorePushResult } from './push';
export { redirectUri as procoreRedirectUri } from './oauth';
