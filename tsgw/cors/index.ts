import { isIP } from "node:net";

function normalizeHostname(value: string): string {
  return value.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
}

function parseHttpOrigin(value: string): URL | null {
  if (/[\s\\*]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || /[*,]/.test(url.hostname)
    ) return null;
    return url;
  } catch {
    return null;
  }
}

function readCorsHostnames(value = process.env.TSGW_ALLOWED_ORIGINS ?? ""): string[] {
  const hostnames = new Set<string>();
  for (const entry of value.split(",").map(value => value.trim()).filter(Boolean)) {
    const authority = isIP(entry) === 6 ? `[${entry}]` : entry;
    const url = parseHttpOrigin(authority.includes("://") ? authority : `http://${authority}`);
    if (!url) {
      throw new Error("TSGW_ALLOWED_ORIGINS requires exact hostnames or HTTP(S) origins; wildcards are not supported.");
    }
    hostnames.add(normalizeHostname(url.hostname));
  }
  return [...hostnames];
}

export function mergeCorsAllowedHosts(env: Record<string, string | undefined> = process.env): void {
  const hostnames = readCorsHostnames(env.TSGW_ALLOWED_ORIGINS ?? "");
  if (!hostnames.length) return;

  const merged = new Map<string, string>();
  for (const value of (env.PI_WEB_ALLOWED_HOSTS ?? "").split(",").map(value => value.trim()).filter(Boolean)) {
    const authority = isIP(value) === 6 ? `[${value}]` : value;
    const url = parseHttpOrigin(`http://${authority}`);
    merged.set(normalizeHostname(url?.hostname ?? value), value);
  }
  for (const hostname of hostnames) {
    if (!merged.has(hostname)) merged.set(hostname, hostname);
  }
  env.PI_WEB_ALLOWED_HOSTS = [...merged.values()].join(",");
}

export function getAllowedCorsOrigin(request: Request, hostnames = readCorsHostnames()): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const url = parseHttpOrigin(origin);
  return url && hostnames.includes(normalizeHostname(url.hostname)) ? origin : null;
}

export function withCors(
  request: Request,
  next: () => Response,
  isRequestAllowed: (request: Request) => boolean,
): Response {
  const pathname = new URL(request.url).pathname;
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return next();

  const hostnames = readCorsHostnames();
  if (!hostnames.length) return next();

  const origin = getAllowedCorsOrigin(request, hostnames);
  const isPreflight = request.method === "OPTIONS"
    && request.headers.has("access-control-request-method");
  // Browsers send no credentials on preflight; the actual request still goes
  // through the original proxy, including its authentication and throttle.
  const response = isPreflight && origin && isRequestAllowed(request)
    ? new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    })
    : next();

  const vary = response.headers.get("Vary");
  if (!vary?.split(",").some(value => ["*", "origin"].includes(value.trim().toLowerCase()))) {
    response.headers.append("Vary", "Origin");
  }
  if (origin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, Retry-After");
  }
  return response;
}
