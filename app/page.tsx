// app/page.tsx — home page, redirects to /tournaments
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/tournaments");
}
