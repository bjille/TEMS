const nodemailer = require('nodemailer');
const env = require('../config/env');

let transporter;

function getTransporter() {
  if (!env.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.port === 465,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
    });
  }
  return transporter;
}

/**
 * Sends a plain-text e-mail. Falls back to a console warning when SMTP isn't
 * configured, so global automations remain usable (and testable) without a
 * mail server in dev/CI.
 */
async function sendMail({ to, subject, text }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (recipients.length === 0) return;

  const client = getTransporter();
  if (!client) {
    console.warn(`[mailer] SMTP not configured, skipping e-mail to ${recipients.join(', ')}: ${subject}`);
    return;
  }

  await client.sendMail({ from: env.smtp.from, to: recipients.join(', '), subject, text });
}

module.exports = { sendMail };
