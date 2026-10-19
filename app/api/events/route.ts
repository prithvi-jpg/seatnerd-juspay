import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const events = (await sql`
    SELECT e.*,
      (SELECT json_agg(json_build_object(
         'id', t.id, 'name', t.name, 'face_value', t.face_value,
         'capacity', t.capacity, 'sold', t.sold, 'held', t.held,
         'available', GREATEST(t.capacity - t.sold - t.held, 0)
       ) ORDER BY t.face_value DESC)
       FROM tiers t WHERE t.event_id = e.id) AS tiers
    FROM events e
    ORDER BY e.starts_at
  `) as unknown as Array<Record<string, unknown>>;

  return NextResponse.json({ events });
}
