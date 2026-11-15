import { suppressTracing } from "@sentry/nextjs";

/** Native NodeFetch also omits breadcrumbs for suppressed requests (Sentry 11.9). */
export function credentialFetch(
  fetchImpl: typeof fetch, input: Parameters<typeof fetch>[0], init?: RequestInit,
): Promise<Response> {
  // Telegram puts its token in the path; Weixin login puts an authorization ticket in the query.
  return suppressTracing(() => fetchImpl(input, init));
}
