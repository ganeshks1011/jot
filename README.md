# Jot — Write it rough. Jot it right.

A Chrome extension that rewrites rough text into polished writing, right from any text field. Select text, hit **Ctrl+Shift+Space**, pick a style, done.

## Repo layout

- `extension/` — the Chrome extension (WXT framework). Backend: `https://codevu.com/api/jot/v1` (100 free rewrites/month per install, no account needed).
- `packages/jot-ui/` — shared UI components used by the extension.
- `site/` — landing page source (`index.html`, `privacy.html`, `styles.css`). The live site is served at `https://codevu.com/jot`.

## Development

```bash
cd extension
npm install
npm run dev      # WXT dev mode
npm run build    # production build -> .output/
```

## Release (Chrome Web Store)

1. Bump `version` in `extension/wxt.config.ts` (and `package.json`).
2. `npm run build` in `extension/`, zip `.output/chrome-mv3`.
3. Upload the zip in the Chrome Web Store developer dashboard; Ganesh does the upload.

## Backend

The rewrite backend lives in `gnsh1725-cpu/codevu_com` (`app/actions/api/jot.ts`):
- `POST /api/jot/v1/rewrite` `{ installId, text, style? }` → `{ ok, rewrite, quota }`
- `GET /api/jot/v1/quota?installId=` → `{ ok, quota }`
- `POST /api/jot/v1/analytics` fire-and-forget ping

Privacy: text is never stored server-side; redaction happens on-device in the extension. Full policy: https://codevu.com/jot/privacy
