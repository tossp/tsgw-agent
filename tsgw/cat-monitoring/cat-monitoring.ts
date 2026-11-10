import { captureException } from "@sentry/nextjs";

/** Monitoring must never change the result of an agent operation. */
export function reportCatError(
  error: unknown,
  tags: Record<string, string | number | boolean | undefined>,
): void {
  if (error instanceof Error && error.name === "AbortError") return;
  try {
    captureException(error, { tags });
  } catch { /* monitoring is best-effort */ }
}
