import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AgentSession,
  createAgentSessionFromServices,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";

type Marker = (stream: StreamFn, runtime: ModelRuntime) => void;
type RuntimeStream = { runtime: ModelRuntime; mark: Marker };
// Provenance, not a guess from a session's shape: only the SDK creation below adds originals.
const runtimeStreams = new WeakMap<StreamFn, RuntimeStream>();
let markerPromise: Promise<Marker> | undefined;

async function loadMarker(): Promise<Marker> {
  const manifest = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
  if (!manifest) throw new Error("Cannot locate the Pi SDK for Agent tracing auth preservation");
  const url = pathToFileURL(join(dirname(manifest), "dist/core/agent-session.js")).href;
  // Keep the SDK's own module instance and private WeakMap, not a bundled second copy.
  const sdkModule = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url);
  if (sdkModule.AgentSession !== AgentSession || typeof sdkModule.markRuntimeStreamFunction !== "function") {
    throw new Error("Pi SDK Agent tracing auth contract changed: expected the same AgentSession and runtime stream marker");
  }
  return sdkModule.markRuntimeStreamFunction as Marker;
}

/** Call at the two host creation sites, before extensions bind or receive the session. */
export async function createTracingAgentSessionFromServices(
  options: Parameters<typeof createAgentSessionFromServices>[0],
): ReturnType<typeof createAgentSessionFromServices> {
  const mark = await (markerPromise ??= loadMarker());
  const runtime = options.services.modelRuntime;
  const result = await createAgentSessionFromServices(options);
  runtimeStreams.set(result.session.agent.streamFunction, { runtime, mark });
  return result;
}

/** Preserve SDK auth only for a known original (or one of our own wrappers of it). */
export function inheritRuntimeStreamAuth(original: StreamFn, wrapped: StreamFn): void {
  const source = runtimeStreams.get(original);
  if (!source) return;
  source.mark(wrapped, source.runtime);
  runtimeStreams.set(wrapped, source);
}
