# Chronicle feedback relay

A tiny Vercel serverless function that forwards Chronicle feedback to email via
[Resend](https://resend.com). It exists so the Resend API key lives **server-side**
(one env var) instead of in the public app — every user's Chronicle can send
feedback without shipping a secret, and delivery doesn't depend on anyone's laptop.

```
User's Chronicle  →  POST /api/feedback (this relay)  →  Resend  →  your inbox
```

## Deploy

```bash
cd feedback-relay
vercel --prod            # deploy to your Vercel account
```

Then set the environment variables on the project (Vercel dashboard → Settings →
Environment Variables, or the CLI):

```bash
vercel env add RESEND_API_KEY production     # your Resend key (re_...)
vercel env add FEEDBACK_TO   production      # optional; default feedback@getchronicle.dev
vercel env add FEEDBACK_FROM production      # optional; default Chronicle Feedback <feedback@getchronicle.dev>
vercel --prod                                # redeploy so the env vars take effect
```

**About `FEEDBACK_FROM`:** it must be an address on a domain you've verified in
Resend (here, `getchronicle.dev`). The relay sends to `feedback@getchronicle.dev`,
which Porkbun email-forwarding relays to the maintainer's inbox — so the personal
address never appears in this repo, the app bundle, Resend, or Vercel.

## Point Chronicle at it

Chronicle's `/api/feedback` posts to the URL in `CHRONICLE_FEEDBACK_RELAY` (env) or
`feedbackRelay` in `~/.chronicle/config.json`, falling back to the baked-in default
in `server/api.js`. After the first deploy, set the default there to this project's
production URL so it ships to all users.

## Notes

- The endpoint is public (no secret needed to call it). It caps message length and
  accepts POST only. Add Vercel rate-limiting / a firewall rule if abuse appears.
- Feedback is always written to `~/.chronicle/feedback.log` in the app before the
  relay call, and the app falls back to a `mailto:` draft if the relay is down.
