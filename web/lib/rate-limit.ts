import { createHmac } from "node:crypto";
import { HttpError } from "./auth";
import { sql } from "./db";
import { authSecret } from "./env";
import { ipBucket } from "./client-ip";

type Rule = { scope: string; key: string; limit: number; window: string };

const keyOf = (scope: string, raw: string) => createHmac("sha256", authSecret()).update(`${scope}:${raw}`).digest("hex");

/**
 * Records one attempt for each rule and refuses with 429 when any of them is over its limit. The attempt is
 * written before the (slow) work is done, in the same statement that counts, so parallel requests can't
 * slip past the limit. Call the returned `release()` when the attempt succeeded and shouldn't count.
 */
export async function limit(rules: Rule[], message = "Too many attempts. Try again in a few minutes."): Promise<{ release: () => Promise<void> }> {
  const db = sql();
  const ids: string[] = [];
  let over = false;
  for (const r of rules) {
    const key = keyOf(r.scope, r.key);
    const [row] = await db`
      with ins as (insert into auth_attempts (scope, key) values (${r.scope}, ${key}) returning id)
      select (select id from ins) as id, 1 + count(*) as n
      from auth_attempts where scope = ${r.scope} and key = ${key} and at > now() - ${r.window}::interval`;
    ids.push(String(row.id));
    if (Number(row.n) > r.limit) over = true;
  }
  const release = async () => {
    await db`delete from auth_attempts where id = any(${ids}::bigint[])`;
  };
  if (over) {
    await release(); // a refused attempt doesn't extend the lockout
    throw new HttpError(429, message);
  }
  if (Math.random() < 0.02) db`delete from auth_attempts where at < now() - interval '1 day'`.catch(() => {});
  return { release };
}

export const ipKey = (ip: string) => ipBucket(ip);
