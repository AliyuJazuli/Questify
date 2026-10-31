# Questify

Questify is an offline-first, gamified daily challenge and habit tracker. It helps people turn small daily goals into a visible, motivating routine through XP, streaks, badges, calendars, and progress statistics.

## Highlights

- Create and complete daily challenges
- Create daily habits and track check-ins across a weekly grid and calendar
- Earn XP, build streaks, and unlock badges
- Review combined habit and challenge activity in the calendar
- See profile progress, XP, badges, and activity statistics together
- Use optional quiet focus during timed Lock In sessions, with an exit warning and pause/recovery choices
- Personalize the experience with profile and settings views
- Choose from six themes with distinct typography and visual treatments; Ocean is the default
- Manage optional daily browser reminders and Questify-only quiet focus during Lock In
- Works offline as a Progressive Web App (PWA)
- Check for and install the latest PWA version from Settings
- Stores data locally in the browser; no account or server is required

## Built with

- HTML5
- CSS3
- Vanilla JavaScript
- Web App Manifest and Service Worker APIs
- `localStorage` for on-device persistence

## Run locally

Questify has no build step or external dependencies.

1. Clone the repository.
2. Serve the folder through any local static-file server.
3. Open the local URL in a modern browser.

For example, using VS Code, install the **Live Server** extension and choose **Open with Live Server** from `index.html`.

> Use a local server rather than opening the file directly so that the service worker and PWA features work correctly.

## Deploy with Netlify

Questify is a static site with no build step. The included `netlify.toml` configures Netlify to publish the repository root. The public URL configured for indexing is `https://hydev-questify.netlify.app/`; confirm that this Netlify site is active and connected to this repository before relying on automatic deploys.

To deploy commits automatically, connect this GitHub repository (`AliyuJazuli/Questify`) to your Netlify site:

1. Sign in to Netlify and open the site you want to deploy.
2. In the site's build and deployment settings, link the repository under continuous deployment.
3. Select `main` as the production branch and use the repository root as the publish directory. No build command is needed.
4. Save the settings and trigger the initial deploy. Future pushes to `main` will deploy automatically; pull requests can receive deploy previews.

Netlify must be authorized to access the GitHub repository. Do not add Netlify access tokens to the repository.

## Search indexing and social sharing

The public app URL is `https://hydev-questify.netlify.app/`. The page defines its canonical URL, search description, Open Graph and X/Twitter share metadata, and `WebApplication` structured data in `index.html`. The social preview uses the 1200 x 630 `social-preview.png` image.

The root `robots.txt` allows crawlers and points to `sitemap.xml`, which lists the app and its privacy policy. App views use client-side navigation and are not separate indexable pages; shared links and the canonical URL should use the root URL without a `#login` or other view fragment.

After deploying changes:

1. In Google Search Console, add and verify the URL-prefix property `https://hydev-questify.netlify.app/` if it is not already available. A different Netlify site or portfolio property does not verify this app URL.
2. Submit `https://hydev-questify.netlify.app/sitemap.xml` under **Sitemaps**.
3. Use **URL inspection** on `https://hydev-questify.netlify.app/`, run a live test, then request indexing if Google reports that the page can be indexed.
4. Preview shared metadata with a social card debugger after deployment. Social profile links are not displayed because none have been supplied.

Google decides when and whether a submitted URL appears in search results; requesting indexing is not a guarantee of inclusion or ranking.

## Privacy and notifications

Questify stores the profile, habits, challenges, check-ins, and progress in the current browser's local storage. It has no account or Questify user-data backend, and data does not sync between devices. The service worker caches app files for offline use. See [Privacy Policy](./privacy.html) for details, including the Google Fonts resource loaded while online.

Daily browser reminders are opt-in and require browser notification permission. Quiet focus can mute Questify alerts and reminders during a Lock In session. A PWA cannot pause notifications from other apps or system-level alerts, and there is no browser permission that grants this ability. To silence all apps, turn on your device's Do Not Disturb/Focus mode separately; integrating that control would require a native app and platform APIs where available.

The six themes intentionally change more than color: Ocean (default) uses crisp coastal glass and sans-serif typography; Aurora is airy, rounded glass; Forest uses botanical colors and serif typography; Sunset is warm and playful with rounded controls; Lavender pairs dusk colors with soft handwritten headings; Midnight uses a sharper, terminal-inspired display face and compact surfaces. Theme and Quiet Focus preferences are stored locally.

The layout is designed mobile-first: the top navigation scrolls horizontally, cards and settings rows reflow to the viewport, and the weekly habit tracker keeps its seven daily check-ins visible on small screens.

## Roadmap

- Export and import progress
- Accessibility testing and keyboard-navigation improvements
- Optional cloud backup
- Automated tests

## License

All rights reserved.
