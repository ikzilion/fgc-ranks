import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  try {
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "FGC Ranks <onboarding@resend.dev>",
      to,
      subject: "Reset your FGC Ranks password",
      html: `
        <p>Someone requested a password reset for your FGC Ranks account.</p>
        <p><a href="${resetUrl}">Click here to reset your password</a>. This link expires in 1 hour.</p>
        <p>If you didn't request this, you can safely ignore this email — your password won't change.</p>
      `,
    });
  } catch (err) {
    console.error(
      "[sendPasswordResetEmail] resend.emails.send failed:",
      err instanceof Error ? { name: err.name, message: err.message, cause: err.cause } : err
    );
    throw err;
  }
}
