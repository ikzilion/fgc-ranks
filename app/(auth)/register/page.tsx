// app/(auth)/register/page.tsx
// Server component so the Turnstile site key (dummy in dev, real env var in
// production) can be resolved server-side and passed to the client form —
// same server-fetch/client-interactive split used elsewhere in the app.
import { getTurnstileSiteKey } from "@/lib/turnstile";
import { RegisterForm } from "@/components/RegisterForm";

export default function RegisterPage() {
  return <RegisterForm siteKey={getTurnstileSiteKey()} />;
}
