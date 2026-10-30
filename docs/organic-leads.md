# Organic lead review

## Baseline (30 October 2026)

Search Console, available data 3–28 October: 17 search clicks and 360 impressions. All 17 clicks landed on the homepage. The four blog articles were indexed but had no recorded clicks; the college loneliness article had 23 impressions, the most of any article.

GA4 received a consented live page view on 30 October. The `sign_up` event is configured as a key event, but a real signup with analytics consent has not yet been observed in Realtime. Analytics is optional, so GA4 signups are a consented subset rather than the total number of accounts created.

## Review each week

1. In [Search Console performance](https://search.google.com/search-console/performance/search-analytics?resource_id=sc-domain%3Amymentallyprepare.com), compare the last 28 days with the previous 28 days. Record clicks and impressions for nonbrand queries and for each article. Filter out the brand query `mentally prepare` when judging organic discovery.
2. In [GA4 acquisition](https://analytics.google.com/analytics/web/#/a357787976p557296645/reports/intelligenthome), compare Organic Search sessions, landing pages, and `sign_up` key events for the same dates. Treat Direct separately from Organic Search.
3. Check the site's own account totals for all signups. GA4 cannot count visitors who decline analytics cookies.
4. Note which article gained relevant impressions, clicks, and consenting signups. Improve that page's answer, title, internal links, and signup invitation when the data points to a specific gap. Avoid drawing conclusions from a few impressions.

## Immediate verification still needed

After the next genuine consenting signup, check GA4 Realtime for `sign_up`. Code review confirms the signup flow invokes the event after successful account creation, but it does not prove delivery to GA4. Do not create a fake production account or send a synthetic conversion just to make the dashboard show one.
