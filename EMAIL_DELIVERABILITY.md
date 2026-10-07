# Email domain cutover and delivery check

Status: code prepared for review. Do not deploy the address changes until the three public inboxes or aliases are confirmed to receive mail.

## Public addresses

The site now points to `privacy@mymentallyprepare.com` and `terms@mymentallyprepare.com`; push contact falls back to `hello@mymentallyprepare.com`. Create or confirm these inboxes/aliases in the actual receiving provider before release. Reply to each from an unrelated mailbox and confirm delivery. Do not rely on DNS MX records alone to prove an individual address exists.

## Sending identity

Check the live Railway service without exposing secrets. It uses Resend when `RESEND_API_KEY` and a valid `RESEND_FROM_EMAIL` are set; otherwise it uses configured SMTP. Set the effective From address to an address at the verified `mymentallyprepare.com` domain. Confirm the sender address and domain in the chosen provider before changing Railway variables. The example address in `.env.example` is illustrative and must not be used until its mailbox or reply alias works.

Current public DNS inspection (2026-10-07): apex SPF includes Hostinger only; DMARC is `p=none`; MX advertises both Google and Hostinger servers. These records do not prove DKIM or sender alignment. Determine the receiving provider before removing or changing any MX record. Publish exactly the SPF/DKIM records supplied by the actual sending provider, then confirm the From domain aligns with an authenticated SPF or DKIM domain. Do not add a second apex SPF record. Check a received message's headers for SPF, DKIM and DMARC results.

## Test without notifying users

1. Send one verification or password-reset email only to a controlled team mailbox, after approved production sender configuration.
2. Confirm From and Reply-To identity, all links, plain-text and HTML bodies, SPF/DKIM/DMARC results, and inbox/spam placement at Gmail and another provider.
3. Confirm public contact addresses receive replies and that provider dashboards report no bounces or complaints.
4. Review scheduled-email consent and user opt-out before enabling routine email at scale. Account-security emails remain separate from optional reminders.

No subject line guarantees inbox placement. Keep subjects accurate and brief; avoid pressure, fabricated urgency, private journal content and partner identity. Send only messages the person expects.
