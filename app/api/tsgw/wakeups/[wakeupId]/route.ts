import { clearWakeupRecord, readWakeupQuery } from "@/tsgw/wakeups/server";

export async function DELETE(_request: Request, context: { params: Promise<{ wakeupId: string }> }) {
  try {
    const { wakeupId } = await context.params;
    return Response.json(clearWakeupRecord(wakeupId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // The runtime may originate from the instrumentation bundle, with a different Error constructor.
    const code = (error as { details?: { code?: string } } | null)?.details?.code;
    const status = code === "wakeup_not_found" ? 404 : code === "wakeup_not_clearable" ? 409 : 503;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status, headers: { "Cache-Control": "no-store" } });
  }
}

export async function GET(_request: Request, context: { params: Promise<{ wakeupId: string }> }) {
  try {
    const { wakeupId } = await context.params;
    return Response.json(await readWakeupQuery({ wakeup_id: wakeupId }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
