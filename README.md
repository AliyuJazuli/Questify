# Questify

Questify is an offline-first, gamified daily challenge and habit tracker. It helps people turn small daily goals into a visible, motivating routine through XP, streaks, badges, calendars, and progress statistics.

## Highlights

- Create and complete daily challenges
- Create, edit, archive, and delete daily habits; preserve check-in history when editing
- Organize habits into General, Health, Work, Learning, and Personal categories
- Choose Easy, Medium, or Hard habit difficulty for configurable 3, 5, or 8 XP rewards
- Track habit completion with daily, weekly, and monthly analytics, streaks, and consistency charts
- Earn XP, build streaks, and unlock badges across habits, challenges, Lock In, and other Questify milestones
- Review actual habit check-ins, challenge completions, XP, daily completion, and monthly activity summaries in month, week, and day calendar views
- See profile progress, XP, badges, and activity statistics together
- Use optional Questify-only notification suppression during timed Lock In sessions, with a live timer and interruption recovery choices
- Manage focus sessions in a dedicated Lock In workspace, separate from Challenges
- Keep session-only Lock In notes or save them into a color-coded Sticky Notes library; open the timer and notes in independent browser windows while keeping the main Lock In timer visible
- Navigate with a collapsible desktop sidebar, adaptive tablet rail, and a floating five-item bottom bar with direct Challenges access and a More menu for secondary pages
- Jump from the dashboard into the Lock In focus-session setup with a prominent focus card
- Personalize the experience with profile and settings views
- Choose from six themes with distinct typography and visual treatments; Sunset is the default unless you choose another theme
- Manage optional daily browser reminders and Questify-only quiet focus during Lock In
- Works offline as a Progressive Web App (PWA)
- Check for PWA updates in Settings, see when the app is up to date, and choose whether to install an available version or keep using the current one
- Stores data locally in the browser; no account or server is required
- Records local acceptance of versioned Privacy and Terms documents before first use

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

Questify is a static site with no build step. The included `netlify.toml` configures Netlify to publish the repository root. The public URL configured for indexing is `https://questify-hydev.netlify.app/`; confirm that this Netlify site is active and connected to this repository before relying on automatic deploys.

To deploy commits automatically, connect this GitHub repository (`AliyuJazuli/Questify`) to your Netlify site:

1. Sign in to Netlify and open the site you want to deploy.
2. In the site's build and deployment settings, link the repository under continuous deployment.
3. Select `main` as the production branch and use the repository root as the publish directory. No build command is needed.
4. Save the settings and trigger the initial deploy. Future pushes to `main` will deploy automatically; pull requests can receive deploy previews.

Netlify must be authorized to access the GitHub repository. Do not add Netlify access tokens to the repository.

## Search indexing and social sharing

The public app URL is `https://questify-hydev.netlify.app/`. The page defines its canonical URL, search description, Open Graph and X/Twitter share metadata, and `WebApplication` structured data in `index.html`. The social preview uses the 1200 x 630 `social-preview.png` image. The Privacy Policy and Terms of Service are available as separate pages.

The root `robots.txt` allows crawlers and points to `sitemap.xml`, which lists the app and its privacy policy. App views use client-side navigation and are not separate indexable pages; shared links and the canonical URL should use the root URL without a `#login` or other view fragment.

After deploying changes:

1. In Google Search Console, add and verify the URL-prefix property `https://questify-hydev.netlify.app/` if it is not already available. A different Netlify site or portfolio property does not verify this app URL.
2. Submit `https://questify-hydev.netlify.app/sitemap.xml` under **Sitemaps**.
3. Use **URL inspection** on `https://questify-hydev.netlify.app/`, run a live test, then request indexing if Google reports that the page can be indexed.
4. Preview shared metadata with a social card debugger after deployment. Social profile links are not displayed because none have been supplied.

Google decides when and whether a submitted URL appears in search results; requesting indexing is not a guarantee of inclusion or ranking.

## Privacy and notifications

Questify stores the profile, habits, challenges, check-ins, progress, preferences, and current legal-document acceptance in the current browser's local storage. It has no account or Questify user-data backend, and data does not sync between devices. The service worker caches app files for offline use. See [Privacy Policy](./privacy.html) and [Terms of Service](./terms.html) for details, including the Google Fonts resource loaded while online.

Daily browser reminders are opt-in and require browser notification permission. Quiet focus suppresses new Questify toasts, notification-log entries, and browser reminders during a Lock In session; it cannot recall notifications already delivered. A PWA cannot pause notifications from other apps or system-level alerts, and there is no browser permission that grants this ability. To silence all apps, turn on your device's Do Not Disturb/Focus mode separately; integrating that control would require a native app and platform APIs where available.

The six themes intentionally change more than color: Sunset (default) is warm and playful with rounded controls; Ocean uses crisp coastal glass and sans-serif typography; Aurora is airy, rounded glass; Forest uses botanical colors and serif typography; Lavender pairs dusk colors with soft handwritten headings; Midnight uses a sharper, terminal-inspired display face and compact surfaces. Theme and Quiet Focus preferences are stored locally.

The layout adapts by device by default: a collapsible sidebar on desktop/tablet and a safe-area-aware floating bottom bar on phones. Users can choose Auto, Sidebar, or Bottom bar in Settings; the choice is stored locally in each browser. On phones, Sidebar opens in a slide-out drawer so the page content stays full-width. The pinned mobile app bar centers the Questify brand, with navigation and notification actions kept separate. Workspace navigation includes Dashboard, Habits, Calendar, and Lock In; Challenges is grouped with badges and Sticky Notes under Progress. On phones, a visually distinct More tile opens secondary destinations. The active destination gently breathes; the More group widens and changes shape when selected. The calendar uses responsive month, week, and day views: month tiles show habit progress and earned XP, the monthly summary reports recorded check-ins, completed challenges, XP, and completion rate, and the selected date includes habit details, difficulty, and challenge activity. Week-day cards also show completion and XP and can be selected with a keyboard. Calendar metrics are derived from locally stored history. When the page is at the top, pulling down from content reveals a compact Questify refresh chip with a gesture-linked progress ring; releasing at the threshold refreshes the app and checks for the latest deployment when online. Browser-controlled refresh UI cannot be replaced on every platform, but Questify suppresses native overscroll refresh where supported. Lock In can open in its own minimal browser window, with the navigation and other views hidden. Its timer can also open in a separate browser window; the standard timer remains visible and usable in Lock In, and both windows control the same session. Session-only notes and saved Sticky Notes open in their own editable windows and stay independent from timer pinning. These are ordinary browser windows, not guaranteed always-on-top system overlays; the browser and operating system control their positioning, focus, and minimization behavior. Lock In notes are temporary unless explicitly saved to the multi-note Sticky Notes library. Habit check-ins remain available in the weekly grid, with analytics and calendar views designed to reflow for smaller screens. New and existing local profiles must accept the current Privacy Policy and Terms of Service once; acceptance is stored locally and requested again if the document version changes. A contextual walkthrough can be skipped or replayed from Settings.

## Roadmap

- Export and import progress
- Accessibility testing and keyboard-navigation improvements
- Optional cloud backup
- Automated tests

## License

All rights reserved.
