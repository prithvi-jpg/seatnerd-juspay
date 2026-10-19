import { NextResponse } from "next/server";
import { sweepExpiredHolds } from "@/lib/checkout";

export const dynamic = "force-dynamic";

/** Cron entrypoint: release expired holds. Call from Vercel cron. */
export async function POST() {
  const swept = await sweepExpiredHolds();
  return NextResponse.json({ swept, count: swept.length });
}
