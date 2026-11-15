// Every test file gets its own in-memory database and in-memory document store.
process.env.RCM_DATA_DIR = ':memory:';
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.PROCORE_CLIENT_ID;
delete process.env.PROCORE_CLIENT_SECRET;
