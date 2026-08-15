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

## Privacy

All challenges and progress are stored in your browser's local storage. Questify does not send personal data to a server.

## Roadmap

- Export and import progress
- Accessibility testing and keyboard-navigation improvements
- Optional cloud backup
- Automated tests

## License

All rights reserved.
