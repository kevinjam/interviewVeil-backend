// Imported first by each test file: ES imports run before top-level code,
// so env must be set in a module of its own.
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.ANTHROPIC_WORKSPACE_ID ??= "wrkspc_test";
/** Transcription proxy returns 503 without this; CI has no `.env.test`. */
process.env.STT_API_KEY ??= "test-stt-key";
process.env.PUBLIC_URL ??= "http://localhost:8787";
process.env.MODEL_HAIKU ??= "claude-haiku-4-5";
process.env.WEB_URL ??= "http://localhost:5173";
process.env.ADMIN_EMAILS ??= "admin@interviewveil.test";
