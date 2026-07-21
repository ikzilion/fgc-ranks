import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  try {
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "FGC Ranks <onboarding@resend.dev>",
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

export async function sendVerificationEmail(to: string, verifyUrl: string) {
  try {
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "FGC Ranks <onboarding@resend.dev>",
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
