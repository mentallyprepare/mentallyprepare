# Campaign attribution and app funnel

Implemented November 19, 2026. GA4 property tag: G-8Y96FYSR01.

## Share these links

Use one campaign across a specific initiative. Give each post a unique utm_content.
Replace student_pilot_nov2026 and the content label for each new initiative.

| Placement | Source | Medium | Ready-to-use link |
| --- | --- | --- | --- |
| Instagram bio | instagram | social | https://mymentallyprepare.com/?utm_source=instagram&utm_medium=social&utm_campaign=student_pilot_nov2026&utm_content=bio |
| Instagram reel | instagram | social | https://mymentallyprepare.com/?utm_source=instagram&utm_medium=social&utm_campaign=student_pilot_nov2026&utm_content=reel_one |
| LinkedIn post | linkedin | social | https://mymentallyprepare.com/?utm_source=linkedin&utm_medium=social&utm_campaign=student_pilot_nov2026&utm_content=founder_post_one |
| Email | newsletter | email | https://mymentallyprepare.com/?utm_source=newsletter&utm_medium=email&utm_campaign=student_pilot_nov2026&utm_content=invite_one |
| WhatsApp invitation | whatsapp | referral | https://mymentallyprepare.com/?utm_source=whatsapp&utm_medium=referral&utm_campaign=student_pilot_nov2026&utm_content=invite_one |

Use the tagged link as the actual clickable destination. An Instagram caption URL is not normally a clickable link; use the bio link or a Story link sticker.

Accepted fields: utm_source, utm_medium, utm_campaign, utm_content, utm_id.
Use labels starting with a letter, then letters, digits, underscores, hyphens or dots, up to 80 characters. Seven consecutive digits are rejected.
Never put a person's name, email, phone, scan result or journal text in these labels.
utm_term, advertising click IDs, authentication tokens, screen names, sharing codes, fragments and all other query details are excluded from reported URLs. Referrers retain only their web origin.
Approved labels stay on internal public/app links, including before consent, without storing campaign details in localStorage.

## Event contract

| Step | GA4 event | Trigger |
| --- | --- | --- |
| Visit | page_view | Once on a supported page after analytics consent |
| Open app | app_open | Once per app document after consent |
| Start scan | quiz_started | Start button, after the age check |
| Finish scan | quiz_completed | Guest result retained in session storage or signed-in result accepted by the API; once per scan attempt |
| Start signup | signup_started | Signup/email-onboarding screen opens; once per app document |
| Sign up | sign_up | Successful email registration or a newly created Google account; once per app document |
| First saved note | note_written | A note save succeeds; use the first occurrence per user in the funnel |
| CTA intent | cta_click | A marked public-page link is clicked |

note_written also measures later saved notes; it is not a distinct lifetime-first-note event.
Existing accounts signing in do not emit sign_up.
A click toward signup is only cta_click, not signup_started.
No sign_up_start events are emitted by the new code. Older data retains the old name.
The public scan path is visit, app_open, quiz_started, quiz_completed, signup_started, sign_up, note_written.
Direct signup can happen before the scan. Analyze this as a separate path rather than forcing all visitors into the scan-first order.
Returning users can skip signup entirely.

## GA4 setup and validation after deployment

1. In Realtime or Tag Assistant, open an Instagram-tagged link in a fresh browser session, allow analytics, follow the app link, and complete a test scan. Check the source/medium, page_view, app_open, quiz_started and quiz_completed. Do not create a production account or write a real note just to test tracking.
2. Inspect new registration and saved-note events using consenting genuine activity, or use a local/staging test account. Check that login is not counted as registration.
3. Confirm the stream's enhanced measurement settings do not collect form interactions, private outbound links or browser-history pageviews in the app. The code sends a fixed app URL/title and only the allowlisted milestones; enhanced measurement and GTM configuration must be checked separately in GA4.
4. Create a Funnel Exploration with the scan-first steps above and an open entry when analyzing visitors who land directly in the app. Create a separate signup-first funnel. Use Session source / medium and Session campaign to compare acquisition. Review sign_up and note_written as candidate key events.
5. Deny analytics on a fresh direct /app visit. Confirm no Google tag loads. Grant using Cookie choices, then withdraw; confirm events stop immediately and the page reloads.
6. Compare production event volumes for new dates only. Old Direct/Unassigned sessions cannot be repaired retroactively. Consent denials, blockers and cross-device journeys create measurement gaps. Pre-consent actions are not replayed.
7. The GA4 account settings, report creation, enhanced measurement review and production receipt of events require live verification; code tests alone do not establish them.

No journal text, answers, archetypes, account IDs or form values are accepted by the milestone tracker. Google advertising consent and Google signals stay disabled. The app now offers the same consent control as the website; it no longer relies on visiting the homepage first.

References:
- https://support.google.com/analytics/answer/10917952
- https://developers.google.com/analytics/devguides/collection/ga4/reference/config
- https://developers.google.com/tag-platform/security/guides/consent
