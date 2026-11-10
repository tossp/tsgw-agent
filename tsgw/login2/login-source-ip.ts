import { isIP } from "node:net";

/** Display-only request metadata. Never use these spoofable headers for auth or throttling. */
export function getPiLoginSourceIp(piHeaders: Pick<Headers, "get">): string {
  for (const piHeader of ["x-ts-client-ip", "cf-connecting-ip", "x-real-ip", "x-forwarded-for"]) {
    const piValue = piHeaders.get(piHeader)?.split(",", 1)[0]?.trim();
    if (!piValue || !isIP(piValue)) continue;
    return piValue.startsWith("::ffff:") && isIP(piValue.slice(7)) === 4 ? piValue.slice(7) : piValue;
  }
  // Next fills x-forwarded-for from socket.remoteAddress when no forwarded header was supplied.
  return "";
}
