import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// mail.fgc-ranks.com is now verified with Resend (confirmed via Resend's
// domains API — the root fgc-ranks.com itself is NOT the verified entry,
// the subdomain is). Previously this fell back to Resend's own
// onboarding@resend.dev sandbox sender, which silently refuses delivery to
// anyone but the Resend account owner's own email.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "FGC Ranks <noreply@mail.fgc-ranks.com>";

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: "Reset your FGC Ranks password",
      html: `
        <p>Someone requested a password reset for your FGC Ranks account.</p>
        <p><a href="${resetUrl}">Click here to reset your password</a>. This link expires in 1 hour.</p>
        <p>If you didn't request this, you can safely ignore this email — your password won't change.</p>
      `,
    });
    // The Resend SDK reports API-level rejections (e.g. an unverified
    // sender domain refusing a recipient) via a returned `error` field, not
    // a thrown exception — checking it explicitly is the only way to catch
    // a send that was silently rejected instead of actually delivered.
    if (error) throw error;
  } catch (err) {
    console.error(
      "[sendPasswordResetEmail] resend.emails.send failed:",
      err instanceof Error ? { name: err.name, message: err.message, cause: err.cause } : err
    );
    throw err;
  }
}

export async function sendAccountDeletionEmail(to: string, confirmUrl: string) {
  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: "Confirm deleting your FGC Ranks account",
      html: `
        <p>Someone requested to delete your FGC Ranks account.</p>
        <p><a href="${confirmUrl}">Click here to confirm account deletion</a>. This link expires in 1 hour.</p>
        <p>Confirming schedules your account for deletion in 7 days — it does not happen immediately. You'll get another email once that's scheduled with a link to cancel at any point during those 7 days, or you can cancel by signing back in. Once the 7 days pass without cancelling, your login is disabled and your personal info is scrubbed; your match and tournament history stays intact for the historical record either way.</p>
        <p>If you didn't request this, you can safely ignore this email — your account won't be touched.</p>
      `,
    });
    // Same reasoning as sendPasswordResetEmail — a rejection from Resend's
    // API comes back as `error`, not a thrown exception.
    if (error) throw error;
  } catch (err) {
    console.error(
      "[sendAccountDeletionEmail] resend.emails.send failed:",
      err instanceof Error ? { name: err.name, message: err.message, cause: err.cause } : err
    );
    throw err;
  }
}

// Sent once confirmAccountDeletion actually starts the 7-day grace period
// (settled July 28, 2026) — distinct from sendAccountDeletionEmail above,
// which fires earlier at the REQUEST step, before the grace period (and
// this email's cancelUrl token) even exists yet.
export async function sendAccountDeletionScheduledEmail(to: string, cancelUrl: string, scheduledScrubAt: Date) {
  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: "Your FGC Ranks account is scheduled for deletion",
      html: `
        <p>Your FGC Ranks account is scheduled to be deleted on ${scheduledScrubAt.toDateString()}.</p>
        <p><a href="${cancelUrl}">Click here to cancel the deletion</a> — this works any time before then. You can also cancel by just signing back into your account.</p>
        <p>If you do nothing, your login will be disabled and your personal info (email, avatar, region, team) permanently scrubbed on that date. Your match and tournament history stays intact either way.</p>
        <p>If you didn't request this, cancel it now using the link above — someone else may have access to this email account.</p>
      `,
    });
    if (error) throw error;
  } catch (err) {
    console.error(
      "[sendAccountDeletionScheduledEmail] resend.emails.send failed:",
      err instanceof Error ? { name: err.name, message: err.message, cause: err.cause } : err
    );
    throw err;
  }
}

export async function sendVerificationEmail(to: string, verifyUrl: string) {
  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: "Verify your FGC Ranks email",
      html: `
        <p>Welcome to FGC Ranks! Confirm your email to finish setting up your account.</p>
        <p><a href="${verifyUrl}">Click here to verify your email</a>. This link expires in 24 hours.</p>
        <p>If you didn't create this account, you can safely ignore this email.</p>
      `,
    });
    // Same reasoning as sendPasswordResetEmail — a rejection from Resend's
    // API comes back as `error`, not a thrown exception.
    if (error) throw error;
  } catch (err) {
    console.error(
      "[sendVerificationEmail] resend.emails.send failed:",
      err instanceof Error ? { name: err.name, message: err.message, cause: err.cause } : err
    );
    throw err;
  }
}
