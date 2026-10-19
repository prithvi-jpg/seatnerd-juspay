import Link from "next/link";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Home() {
  const events = (await sql`
    SELECT e.*,
      (SELECT COALESCE(SUM(capacity),0) FROM tiers t WHERE t.event_id = e.id) AS capacity,
      (SELECT COALESCE(SUM(sold),0)    FROM tiers t WHERE t.event_id = e.id) AS sold
    FROM events e ORDER BY e.starts_at
  `) as unknown as Array<{
    id: string; title: string; artist: string; venue: string; city: string;
    starts_at: string; capacity: number; sold: number; hero: string;
  }>;

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "48px 20px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 40 }}>
        <div>
          <div style={{ fontSize: 13, letterSpacing: 2, color: "#7c8698", textTransform: "uppercase" }}>SeatNerd</div>
          <h1 style={{ margin: "4px 0 0", fontSize: 28 }}>Live tickets. Fair prices.</h1>
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <Link href="/demo" style={{ color: "#8ab4ff", fontSize: 14, textDecoration: "none" }}>Failover lab →</Link>
          <Link href="/showcase" style={{ color: "#8ab4ff", fontSize: 14, textDecoration: "none", fontWeight: 600 }}>Live onsale demo →</Link>
          <Link href="/ops" style={{ color: "#8ab4ff", fontSize: 14, textDecoration: "none" }}>Ops console →</Link>
        </div>
      </header>

      <div style={{ display: "grid", gap: 16 }}>
        {events.map((e) => (
          <Link key={e.id} href={`/event/${e.id}`}
            style={{ display: "block", textDecoration: "none", color: "inherit",
                     background: "linear-gradient(135deg, #171b26, #10131c)",
                     border: "1px solid #262c3b", borderRadius: 14, padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 12, color: "#8ab4ff", letterSpacing: 1, textTransform: "uppercase" }}>
                  {e.artist}
                </div>
                <div style={{ fontSize: 24, fontWeight: 600, marginTop: 2 }}>{e.title}</div>
                <div style={{ color: "#aab2c4", marginTop: 6 }}>
                  {e.venue} · {e.city} · {new Date(e.starts_at).toLocaleString("en-US", {
                    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                  })}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#4ade80" }}>
                  {e.sold}/{e.capacity} sold
                </div>
                <div style={{ fontSize: 13, color: "#7c8698" }}>Get tickets →</div>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <footer style={{ marginTop: 48, fontSize: 12, color: "#5a6374", lineHeight: 1.7 }}>
        SeatNerd is a prototype for the Juspay Hyperswitch take-home: US live-event ticketing
        with real sandbox payments. All prices include fees — shown in full before you pay.
      </footer>
    </main>
  );
}
