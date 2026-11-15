import { readWakeupQuery, wakeupQueryFromParams } from "@/tsgw/wakeups/server";

export async function GET(request: Request) {
  try {
    return Response.json(await readWakeupQuery(wakeupQueryFromParams(new URL(request.url).searchParams)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
