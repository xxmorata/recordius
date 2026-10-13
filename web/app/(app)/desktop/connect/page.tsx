import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";

/** The desktop app opens this URL; it just routes to the download page where the connect button lives. */
export default async function DesktopConnect() {
  await requireUser();
  redirect("/download#connect");
}
