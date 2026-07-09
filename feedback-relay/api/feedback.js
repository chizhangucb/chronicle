// Chronicle feedback relay (Vercel serverless function).
//
// Holds the Resend API key SERVER-SIDE (as the RESEND_API_KEY env var) so every
// user's Chronicle can send feedback without shipping a secret in the public app.
// Chronicle's local server POSTs { message, email, platform } here; this forwards
// to Resend. The key never leaves the server and delivery is independent of any
// user's laptop. `email` is optional — when present it becomes the Reply-To so the
// maintainer can reply to the sender directly.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { message, email, platform } = req.body || {};
  const msg = (message ?? '').toString().trim();
  if (!msg) return res.status(400).json({ error: 'Feedback is empty' });
  if (msg.length > 10000) return res.status(413).json({ error: 'Feedback too long' });

  // Optional sender email → Reply-To + surfaced in the subject/body. Only trust it
  // if it looks like an address (it's user-supplied and untrusted).
  const sender = (email ?? '').toString().trim().slice(0, 200);
  const validSender = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender) ? sender : '';

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Relay not configured (set RESEND_API_KEY)' });
  const to = process.env.FEEDBACK_TO || 'feedback@getchronicle.dev';
  // Resend sends to feedback@getchronicle.dev, which Porkbun forwards to the
  // maintainer's inbox. from must be on the Resend-verified getchronicle.dev domain.
  const from = process.env.FEEDBACK_FROM || 'Chronicle Feedback <feedback@getchronicle.dev>';

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to,
        // Reply-To lets the maintainer reply straight to the sender. The visible
        // address also rides along in the message body (the local server appends
        // it), so it shows even before this relay version is deployed.
        ...(validSender ? { reply_to: validSender } : {}),
        subject: validSender ? `Chronicle feedback from ${validSender}` : 'Chronicle feedback',
        text: `${msg}\n\n— platform: ${(platform ?? 'unknown').toString().slice(0, 40)}`,
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.error) {
      return res.status(502).json({ error: body.error?.message || body.message || `resend ${r.status}` });
    }
    return res.status(200).json({ ok: true, id: body.id });
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
}
