// Sentry — Node.js/server runtime (the OpenNext Worker runs Next's server code here).
// Loaded by instrumentation.ts register() when NEXT_RUNTIME === "nodejs". Requires
// wrangler nodejs_compat + compatibility_date >= 2025-08-16 (for https.request) so the
// SDK's transport works on the Workers runtime.
import * as Sentry from "@sentry/nextjs";

// Public DSN (safe to commit); overridable via env for other environments.
const DSN =
  "https://0a20781f4364fe6d9cab0911b670e1a6@o4511768829427712.ingest.us.sentry.io/4511768839520256";

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? DSN,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
  enableLogs: true,
});
