/** Runs once when the server starts: resume any document processing that was queued or interrupted. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  await import('@/server/services/intake'); // registers the job handler
  const { kick } = await import('@/server/jobs');
  kick();
}
