// Sentry — browser/client runtime. Next.js loads this automatically on the client.
import * as Sentry from "@sentry/nextjs";

// Public DSN (safe in the client bundle); overridable via env at build time.
const DSN =
  "https://0a20781f4364fe6d9cab0911b670e1a6@o4511768829427712.ingest.us.sentry.io/4511768839520256";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN ?? DSN,
  // 100% in dev, 10% in production
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
  // Session Replay: 10% of all sessions, 100% of sessions with an error.
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  enableLogs: true,
  integrations: [Sentry.replayIntegration()],
});

// Hook App Router navigation transitions into tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
