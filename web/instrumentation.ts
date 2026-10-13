// Runs once when a server instance starts: brings the database schema up to date (so upgrading never
// needs a manual migration step) and checks the storage configuration.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.APP_URL && !process.env.VERCEL) {
    console.error("[recordius] APP_URL is not set. Set it to the address people open (e.g. https://videos.example.com) — share links, file links and the Mac app depend on it.");
  }
  if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 16) {
    console.error("[recordius] AUTH_SECRET is missing or too short. Set it to a long random string (openssl rand -hex 32) — sign-in won't work until you do.");
  }
  if (process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.POSTGRES_PRISMA_URL) {
    try {
      const { migrate } = await import("./lib/db");
      const ran = await migrate();
      if (ran.length) console.log(`[recordius] applied migrations: ${ran.join(", ")}`);
    } catch (err) {
      console.error("[recordius] migrations failed", err);
    }
  }
  try {
    const { storageProvider } = await import("./lib/blob");
    const provider = storageProvider();
    console.log(`[recordius] storage: ${provider}`);
    if (provider === "s3" && !/^(1|true|yes)$/i.test(process.env.S3_SKIP_CORS ?? "")) {
      // Browsers upload to and play from the bucket directly, so it needs CORS for this site.
      const [{ ensureBucketCors }, { appUrl }] = await Promise.all([import("./lib/storage/s3"), import("./lib/env")]);
      await ensureBucketCors(appUrl()).catch((err) =>
        console.warn(
          `[recordius] couldn't set the bucket's CORS rule (${err.message}). MinIO and Garage allow every origin by default, so there's nothing to do. ` +
            "Elsewhere, add it in your provider's dashboard — see docs/self-hosting.md#storage",
        ),
      );
    }
  } catch (err) {
    console.error(`[recordius] storage is not configured: ${(err as Error).message}`);
  }
}
