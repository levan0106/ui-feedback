# Privacy Policy — UI Feedback Bridge

_Last updated: 2026-11-07_

UI Feedback Bridge is a browser extension for developers. It does not collect, store or transmit personal data to the extension author or any third party.

## What the extension does with data
When you use the "Feedback" overlay on a page at `localhost`, `127.0.0.1` or `https://localhost`, the extension reads the element you select (selector, computed styles, visible text, component chain, source file and line when available), the page URL and viewport size, and the note you type.

This data is sent **only** to the bridge process running on your own computer at `http://127.0.0.1:47831`, so that your coding agent can read it. It never leaves your machine through this extension.

## What we do not do
- No servers operated by the author receive any data.
- No analytics, telemetry, advertising, or tracking.
- No data is sold, shared, or used for any purpose unrelated to the single purpose above.
- The extension runs on no websites other than `localhost` and `127.0.0.1`.
- No remote code is loaded.

## Local storage
The local bridge keeps request history and an access token in `~/.ui-feedback-bridge/` on your computer. You can delete this folder at any time. The extension itself stores nothing.

## Your coding agent
What your coding agent (for example Claude Code or Codex) does with the data it receives is governed by that agent's own provider and settings, not by this extension.

## Contact
<CONTACT_EMAIL_OR_REPO_ISSUES_URL>
