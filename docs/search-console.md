# Search Console, Bing and indexing

The site already does the technical SEO work on every build: one canonical URL per page, `hreflang` for the five
languages, `sitemap.xml` (with alternates and a truthful `lastmod`), `robots.txt`, Open Graph share images, and
`WebApplication` + `FAQPage` structured data. What's left is proving to Google and Bing that you own the domain, so
you can see searches, clicks and indexing problems. Only the owner can do this, because it signs in with your account.

## 1. Google Search Console (10 minutes, once)

**Recommended: Domain property, verified through Cloudflare (no code change).**

1. Go to <https://search.google.com/search-console> and sign in with the Google account that should own the site.
2. Add property → **Domain** → type `omniviewer3d.com` → Continue.
3. Google shows a TXT record. Because the domain's DNS is on Cloudflare, Google usually offers **"Verify with
   Cloudflare"**: click it, sign in to Cloudflare, approve. Otherwise copy the TXT value, then in the Cloudflare
   dashboard → `omniviewer3d.com` → DNS → Add record → Type `TXT`, Name `@`, Content = the value → Save, and click
   Verify in Search Console (it can take a few minutes).
4. In the new property: **Sitemaps** → submit `https://omniviewer3d.com/sitemap.xml`.
5. **URL inspection** → paste `https://omniviewer3d.com/` → **Request indexing**. Do the same for `/convert/` and
   `/stl-viewer/`; the rest is discovered from the sitemap.

**Alternative: HTML tag.** Choose the *URL prefix* property, method *HTML tag*, copy only the `content="…"` value,
add it as a GitHub repository secret named `GOOGLE_SITE_VERIFICATION`, and push. Every page then carries
`<meta name="google-site-verification" …>` (see `verificationMeta()` in `scripts/seo.mjs`).

## 2. Bing Webmaster Tools (5 minutes; also feeds DuckDuckGo, Ecosia, Yahoo and ChatGPT search)

1. <https://www.bing.com/webmasters> → sign in → **Import from Google Search Console** (fastest: imports the verified
   site and sitemap). Or add the site and use the XML/meta method with the secret `BING_SITE_VERIFICATION`.
2. Optional, instant re-crawls: create any 32-character key (letters and digits), save it as the secret
   `INDEXNOW_KEY`. Builds then publish `/<key>.txt`; after a deploy run
   `INDEXNOW_KEY=<key> node scripts/indexnow.mjs` to ping Bing, Yandex, Seznam and Naver.

## 3. What to watch in the first month

- **Pages → Why pages aren't indexed.** "Discovered – currently not indexed" is normal for a new site with ~450
  pages; it shrinks as links and visits grow. "Duplicate without user-selected canonical" would mean a canonical bug.
- **Performance → Queries.** Look for converter and viewer queries ("step to stl", "f3d file", "stl viewer").
  Pages with impressions but a low click rate need a better title or description in `scripts/seo-data.mjs`.
- **Experience → Core Web Vitals.** The app bundle is large; if pages show "Poor", lazy-load the rarely used panels.

## 4. Traction beyond Search Console

- List it where makers look: Printables and Thingiverse profile links, r/3Dprinting and r/functionalprint ("free,
  no upload" is the hook), AlternativeTo (as an alternative to Autodesk Viewer, 3D Viewer Online, ImageToStl),
  Product Hunt, and the "awesome-3d-printing" / "awesome-threejs" lists on GitHub.
- The new guide pages (`/f3d-file/`, `/sldprt-file/`, `/skp-file/`, …) target very common "how do I open X" searches
  and send people to a format that works here.
- Keep the promise: no ads, no accounts, **no automatic analytics**. Search Console and Bing Webmaster give search
  data without adding any tracking to the site. Turn off Cloudflare Web Analytics / Browser Insights (Cloudflare
  dashboard → Analytics & Logs → Web Analytics → the site → Disable automatic setup), which currently injects a
  beacon into every page.
