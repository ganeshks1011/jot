# Jot — Privacy Policy

_Last updated: August 2026_

Jot is a Chrome extension that helps you rewrite text you are writing on the web. This policy explains exactly what Jot accesses, when, and why.

## Website and Page Access

Jot does not require permanent access to the websites you visit. Jot uses Chrome's activeTab permission to obtain temporary access to the active browser tab when you explicitly invoke Jot, such as by using the Jot keyboard shortcut or extension action.

Jot uses this temporary access to identify the text you want to rewrite and to insert the resulting text. Jot does not continuously monitor, scan, or collect the contents of websites you visit.

Jot only accesses webpage content necessary to provide the writing functionality you explicitly request.

## What Jot reads from the page — and only when you ask

When you invoke Jot, it reads one of the following from the current tab:

- the contents of the text field you are focused on (textarea, text-like input, or contenteditable editor), or your selected portion of it;
- if no field is focused, the text you have selected on the page.

Nothing else about the page is read. Jot does not read page HTML, page metadata, cookies, storage, or any other fields on the page.

## What happens to your text

- The captured text is sent only to the AI provider you configured in Jot's settings (the Jot rewrite API backend, or your own bring-your-own-key provider such as OpenAI) for the sole purpose of producing the rewrite you requested.
- Provider requests are relayed through Jot's background service worker.
- Your text is not logged, persisted, or used for analytics by the extension. When you close the overlay, the extension keeps no copy of it.

## What Jot stores locally

- Settings (provider choice, enabled modes, custom prompts, per-site prompt overrides) in `chrome.storage.sync`.
- Your API key and Wurkflo session in `chrome.storage.local` — never synced to your Google account, never logged.
- A cached count of remaining free Wurkflo requests (`X-Jot-Remaining`) in `chrome.storage.local`.
- A random anonymous install id in `chrome.storage.local`, used only to count distinct installs in usage statistics.

Uninstalling the extension removes all of it.

## Anonymous usage statistics (opt-out)

- Jot counts how it is used (opens, rewrites, successes, errors) to improve the product. This is on by default and can be turned off anytime in Settings → "Share anonymous usage statistics".
- Statistics contain only coarse metadata: event names, a broad site label (for example `slack`, never the full page address), editor kind, timings, the active provider and model name, onboarding step position, an anonymous session id that rotates after 30 minutes of inactivity, and — on settings/onboarding pages only — the page title. Error reports carry no messages or stack traces.
- Your message text is never included in statistics, never logged, and never sent to Google Analytics. The analytics backend receives no names, emails, URLs, or account identifiers — only a random per-install id that resets when you reinstall.
- With statistics off, the extension emits nothing — not even install events.

## What Jot never does

- No host permissions; no standing access to any website.
- No persistent content scripts; nothing runs on a page until you invoke Jot.
- No browsing history collection.
- No advertising, remote logging of message content, or selling/sharing of data with third parties beyond the provider you explicitly configure for rewrites.

## Pages where Jot cannot run

Chrome blocks extensions on its own pages (for example `chrome://` pages and the Chrome Web Store). On those pages Jot shows a short notice ("Jot can't work on this page.") and accesses nothing.

## Contact

Questions about this policy? Visit https://wurkflo.app.
