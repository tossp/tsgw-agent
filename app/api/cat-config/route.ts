import { getCatConfig } from "@/lib/cat-config";

export const dynamic = "force-dynamic";

// Only public SDK settings: prebuilt npm packages read the deployment's env at runtime.
export function GET() {
  return Response.json(getCatConfig(), { headers: { "Cache-Control": "no-store" } });
}
