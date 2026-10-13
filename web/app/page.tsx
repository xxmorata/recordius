import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { schemaReady } from "@/lib/db";
import { hasAnyUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await schemaReady()) || !(await hasAnyUser())) redirect("/setup");
  redirect((await currentUser()) ? "/library" : "/login");
}
