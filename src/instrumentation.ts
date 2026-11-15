/**
 * Runs once when a server process starts. Registers the document-processing
 * job handler and, on a long-lived server, starts the queue runner (which first
 * resumes anything queued or interrupted). On serverless hosting nothing may
 * run between requests, so there is no runner to start: see src/server/jobs.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  await import('@/server/services/intake'); // registers the job handler
  const { jobRunnerMode } = await import('@/server/config');
  if (jobRunnerMode() !== 'poll') return;
  const { startJobRunner } = await import('@/server/jobs');
  startJobRunner();
}
