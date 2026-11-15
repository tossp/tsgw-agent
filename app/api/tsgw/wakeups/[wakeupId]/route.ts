import { readWakeupQuery } from "@/tsgw/wakeups/server";

export async function GET(_request: Request, context: { params: Promise<{ wakeupId: string }> }) {
  try {
    const { wakeupId } = await context.params;
    return Response.json(await readWakeupQuery({ wakeup_id: wakeupId }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
