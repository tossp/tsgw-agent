import { NextResponse } from "next/server";
import type { AppUpdateResponse } from "@/lib/api-types";
import { getNpmLatestUrl, getReleaseUrl, readReleaseVersion, isNewerReleaseVersion } from "@/bin/tsgw-release.js";

export const dynamic = "force-dynamic";

const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
const NPM_LATEST_URL = getNpmLatestUrl(CURRENT_VERSION);
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const SKIP_VERSION_CHECK = process.env.PI_WEB_SKIP_VERSION_CHECK === "1";

interface AppUpdateCache {
  value?: AppUpdateResponse;
  expiresAt: number;
  inFlight?: Promise<AppUpdateResponse>;
}

declare global {
  var __piWebAppUpdateCache: AppUpdateCache | undefined;
}

function getCache(): AppUpdateCache {
  return globalThis.__piWebAppUpdateCache ??= { expiresAt: 0 };
}

async function fetchLatestVersion(): Promise<AppUpdateResponse> {
  const response = await fetch(NPM_LATEST_URL, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);

  const latestVersion = readReleaseVersion(await response.json(), CURRENT_VERSION);
  const releaseUrl = getReleaseUrl(latestVersion);
  if (!releaseUrl) throw new Error("npm registry returned an invalid version");

  return {
    currentVersion: CURRENT_VERSION,
    latestVersion,
    updateAvailable: isNewerReleaseVersion(latestVersion, CURRENT_VERSION),
    releaseUrl,
  };
}

async function loadUpdateStatus(): Promise<AppUpdateResponse> {
  const cache = getCache();
  if (cache.value && cache.expiresAt > Date.now()) return cache.value;
  if (!cache.inFlight) {
    cache.inFlight = fetchLatestVersion().then((value) => {
      cache.value = value;
      cache.expiresAt = Date.now() + CACHE_TTL_MS;
      return value;
    }).finally(() => {
      cache.inFlight = undefined;
    });
  }

  try {
    return await cache.inFlight;
  } catch (error) {
    if (cache.value) return cache.value;
    throw error;
  }
}

export async function GET() {
  if (SKIP_VERSION_CHECK) {
    return NextResponse.json({
      currentVersion: CURRENT_VERSION,
      latestVersion: CURRENT_VERSION,
      updateAvailable: false,
      releaseUrl: "",
    } satisfies AppUpdateResponse);
  }
  try {
    return NextResponse.json(await loadUpdateStatus());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
