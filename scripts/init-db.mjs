import { neon, Pool } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";

const sql = neon(process.env.DATABASE_URL);
// neon() is tagged-template only in 0.10.x; use Pool for arbitrary DDL strings.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Pull SCHEMA out of lib/db.ts without needing a TS build step.
const dbTs = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
const m = dbTs.match(/export const SCHEMA = `([\s\S]*?)`;/);
if (!m) throw new Error("Could not extract SCHEMA from lib/db.ts");
const SCHEMA = m[1];

const statements = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);

console.log(`Applying ${statements.length} DDL statements...`);
for (const s of statements) {
  await pool.query(s);
  const head = s.split("\n")[0].slice(0, 70);
  console.log("  ok:", head);
}

if (process.argv.includes("--seed")) {
  console.log("\nSeeding events...");

  await sql`DELETE FROM order_events`;
  await sql`DELETE FROM tickets`;
  await sql`DELETE FROM orders`;
  await sql`DELETE FROM tiers`;
  await sql`DELETE FROM events`;

  await sql`
    INSERT INTO events (id, title, artist, venue, city, starts_at, hero) VALUES
    ('evt_presidio', 'Presidio Sunset', 'Fredrepeat', 'Presidio Tunnel Tops', 'San Francisco, CA',
     '2026-10-03T19:30:00-07:00', 'sunset'),
    ('evt_santacruz', 'Boardwalk Nights', 'Fredrepeat', 'Santa Cruz Civic Auditorium', 'Santa Cruz, CA',
     '2026-10-05T20:00:00-07:00', 'boardwalk')
  `;

  await sql`
    INSERT INTO tiers (id, event_id, name, face_value, capacity, sold, held) VALUES
    ('tier_ga_sf',   'evt_presidio',  'General Admission', 6400,  500, 0, 0),
    ('tier_pit_sf',  'evt_presidio',  'Front Pit',        12800,  80,  0, 0),
    ('tier_lawn_sf', 'evt_presidio',  'Lawn',              3900, 400, 0, 0),
    ('tier_ga_sc',   'evt_santacruz', 'General Admission', 5500, 300, 0, 0),
    ('tier_bal_sc',  'evt_santacruz', 'Balcony',           7200, 150, 0, 0)
  `;

  const events = await sql`SELECT id, title, artist FROM events`;
  const tiers = await sql`SELECT id, name, face_value FROM tiers`;
  console.log("events:", events);
  console.log("tiers:", tiers);
}

console.log("\nDone.");

await pool.end();
