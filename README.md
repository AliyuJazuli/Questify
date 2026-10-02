# Questify

Questify is an offline-first, gamified daily challenge and habit tracker. It helps people turn small daily goals into a visible, motivating routine through XP, streaks, badges, calendars, and progress statistics.

## Highlights

- Create and complete daily challenges
- Earn XP, build streaks, and unlock badges
- Review activity in calendar and statistics views
- Personalize the experience with profile and settings views
- Works offline as a Progressive Web App (PWA)
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

Questify is a static site with no build step. The included `netlify.toml` configures Netlify to publish the repository root.

To deploy commits automatically, connect this GitHub repository (`AliyuJazuli/Questify`) to your Netlify site:

1. Sign in to Netlify and open the site you want to deploy.
2. In the site's build and deployment settings, link the repository under continuous deployment.
3. Select `main` as the production branch and use the repository root as the publish directory. No build command is needed.
4. Save the settings and trigger the initial deploy. Future pushes to `main` will deploy automatically; pull requests can receive deploy previews.

Netlify must be authorized to access the GitHub repository. Do not add Netlify access tokens to the repository.

## Privacy

All challenges and progress are stored in your browser's local storage. Questify does not send personal data to a server.

## Roadmap

- Export and import progress
- Accessibility testing and keyboard-navigation improvements
- Optional cloud backup
- Automated tests

## License

All rights reserved.
