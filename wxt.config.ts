import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

/**
 * Point the extension at a non-production Wurkflo backend (e.g. a local
 * `react-router-serve` instance) by exporting VITE_WURKFLO_ORIGIN before
 * building. Also allow-lists that origin in web_accessible_resources so the
 * web app's redirect to auth-callback.html is permitted.
 */
const wurkfloOrigin = process.env.VITE_WURKFLO_ORIGIN;

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    plugins: [tailwindcss()],
    ...(wurkfloOrigin
      ? {
          define: {
            "import.meta.env.VITE_WURKFLO_ORIGIN": JSON.stringify(wurkfloOrigin),
          },
        }
      : {}),
  }),
  manifest: {
    name: "Jot - AI Writing & Rewriting",
    description: "Write it rough. Jot it right. Turn rough thoughts into replies, comments, posts, and announcements.",
    /**
     * No host permissions, no <all_urls>, no URL-matched content scripts.
     * Jot touches a page only after the user explicitly invokes it:
     * activeTab grants temporary access to the active tab on invocation
     * (keyboard shortcut or action click), and `scripting` injects the
     * jot-host controller via chrome.scripting.executeScript. Closing the
     * overlay tears the controller down completely. `clipboardRead` lets the
     * host-side paste tier read overlay-written flavors; `clipboardWrite`
     * backs the overlay copy buttons (warning-free).
     */
    permissions: ["storage", "activeTab", "scripting", "contextMenus", "clipboardRead", "clipboardWrite"],
    commands: {
      "toggle-jot": {
        suggested_key: {
          default: "Ctrl+Shift+Space",
          mac: "Command+Shift+Space",
        },
        description: "Toggle the Jot overlay on the focused field",
      },
    },
    // Extension pages use Google Fonts (Poppins + Instrument Sans) to match
    // wurkflo.app/jot — allow style/font from Google with fallback to system.
    // connect-src https: is needed for provider relays (DeepSeek, OpenAI, etc.).
    // Plaintext http is scoped to loopback hostnames for local model servers
    // (Ollama, LM Studio) so API keys never leave over cleartext elsewhere.
    // NOTE: no bracketed IPv6 entry — Chromium's CSP parser rejects
    // `http://[::1]/*` as an invalid source and logs a console warning.
    // IPv6 loopback stays supported in the relay allowlist (src/lib/net.ts),
    // which parses via `new URL` and is unaffected by page CSP anyway: all
    // provider traffic goes through the background service worker.
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' https: http://localhost/* http://127.0.0.1/* wss:; worker-src 'self'",
    },
    web_accessible_resources: [
      {
        // The overlay iframe is embedded into web pages at invocation time.
        // WAR only lets pages embed this extension document - it grants no
        // access to those pages. http/https covers every site where Jot can
        // run (file:// additionally requires the user's explicit toggle).
        resources: ["overlay.html"],
        matches: ["http://*/*", "https://*/*"],
      },
      {
        // Landing page for the Wurkflo web auth handoff. Only the site that
        // mints link codes may navigate here; no use_dynamic_url (it breaks
        // chrome-extension:// redirects and origin validation).
        resources: ["auth-callback.html"],
        matches: ["https://wurkflo.app/*", ...(wurkfloOrigin ? [`${wurkfloOrigin}/*`] : [])],
      },
    ],
    icons: {
      16: "icon/icon16.png",
      32: "icon/icon32.png",
      48: "icon/icon48.png",
      128: "icon/icon128.png",
    },
    action: {
      default_icon: {
        16: "icon/icon16.png",
        32: "icon/icon32.png",
        48: "icon/icon48.png",
        128: "icon/icon128.png",
      },
    },
  },
});
