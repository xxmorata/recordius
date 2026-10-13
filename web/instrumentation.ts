// Runs once when a server instance starts: brings the database schema up to date, so upgrading
// Recordius never needs a manual migration step (new tables/columns are additive).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!(process.env.DATABASE_URL ?? process.env.POSTGRES_URL)) return;
  try {
    const { migrate } = await import("./lib/db");
    const ran = await migrate();
    if (ran.length) console.log(`[recordius] applied migrations: ${ran.join(", ")}`);
  } catch (err) {
    console.error("[recordius] migrations failed", err);
  }
}
