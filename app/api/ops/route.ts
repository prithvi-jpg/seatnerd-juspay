import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Ops console aggregates — what a payments dashboard would show. */
export async function GET() {
  const [overview] = (await sql`
    SELECT
      COUNT(*)                                          AS orders_total,
      COUNT(*) FILTER (WHERE state = 'issued')          AS orders_issued,
      COUNT(*) FILTER (WHERE state = 'released')        AS orders_released,
      COUNT(*) FILTER (WHERE state = 'failed')          AS orders_failed,
      COALESCE(SUM(total) FILTER (WHERE state = 'issued'), 0) AS gmv_cents
    FROM orders
  `) as unknown as Array<Record<string, number>>;

  const authByConnector = (await sql`
    SELECT connector, kind, COUNT(*) AS n
      FROM order_events
     WHERE kind IN ('auth_succeeded','auth_failed','webhook_authorized')
       AND connector IS NOT NULL
     GROUP BY connector, kind ORDER BY connector
  `) as unknown as Array<Record<string, string | number>>;

  const declines = (await sql`
    SELECT error_message, unified_code, COUNT(*) AS n
      FROM order_events
     WHERE kind = 'auth_failed' AND error_message IS NOT NULL
     GROUP BY error_message, unified_code ORDER BY n DESC LIMIT 10
  `) as unknown as Array<Record<string, string | number>>;

  const retryDecisions = (await sql`
    SELECT retry_decision, COUNT(*) AS n
      FROM order_events
     WHERE retry_decision IS NOT NULL
     GROUP BY retry_decision
  `) as unknown as Array<Record<string, string | number>>;

  const recent = (await sql`
    SELECT order_id, kind, at, connector, attempt_no, error_message, retry_decision
      FROM order_events ORDER BY id DESC LIMIT 30
  `) as unknown as Array<Record<string, unknown>>;

  const inventory = (await sql`
    SELECT e.title, t.name, t.capacity, t.sold, t.held,
           GREATEST(t.capacity - t.sold - t.held, 0) AS available
      FROM tiers t JOIN events e ON e.id = t.event_id ORDER BY e.starts_at, t.face_value DESC
  `) as unknown as Array<Record<string, unknown>>;

  return NextResponse.json({ overview, authByConnector, declines, retryDecisions, recent, inventory });
}
