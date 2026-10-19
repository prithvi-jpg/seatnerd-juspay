import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { computeFees, formatUSD, cents } from "@/lib/money";
import TierPicker from "@/components/tier-picker";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const event = (
    await sql`SELECT * FROM events WHERE id = ${id}`
  ) as unknown as Array<Record<string, unknown>> | [];

  if (event.length === 0) notFound();
  const e = event[0];

  const tiers = (await sql`
    SELECT * FROM tiers WHERE event_id = ${id} ORDER BY face_value DESC
  `) as unknown as Array<{
    id: string; name: string; face_value: number; capacity: number; sold: number; held: number;
  }>;

  const featured = tiers[0];

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "32px 20px 64px" }}>
      <Link href="/" style={{ color: "#7c8698", fontSize: 14, textDecoration: "none" }}>← All events</Link>

      <div style={{ marginTop: 20, marginBottom: 28 }}>
        <div style={{ fontSize: 13, color: "#8ab4ff", letterSpacing: 1, textTransform: "uppercase" }}>
          {e.artist as string}
        </div>
        <h1 style={{ fontSize: 36, margin: "4px 0 6px" }}>{e.title as string}</h1>
        <div style={{ color: "#aab2c4" }}>
          {e.venue as string} · {e.city as string} ·{" "}
          {new Date(e.starts_at as string).toLocaleString("en-US", {
            weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
          })}
        </div>
      </div>

      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)" }}>
        <div>
          {tiers.map((t) => {
            const avail = Math.max(t.capacity - t.sold - t.held, 0);
            return (
              <div key={t.id} style={{
                border: "1px solid #262c3b", borderRadius: 12, padding: 18, marginBottom: 12,
                background: "#10131c", display: "flex", justifyContent: "space-between", gap: 16,
              }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 17 }}>{t.name}</div>
                  <div style={{ color: "#7c8698", fontSize: 13, marginTop: 4 }}>
                    {avail} of {t.capacity} left
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{formatUSD(cents(t.face_value))}</div>
                  <div style={{ fontSize: 12, color: "#7c8698" }}>+ fees, shown at checkout</div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ position: "sticky", top: 20, alignSelf: "start" }}>
          <TierPicker eventId={id} tiers={tiers} />
        </div>
      </div>
    </main>
  );
}
