/**
 * Architecture enforcement for Jot.
 * Checks layer boundaries per docs/architecture/target.md and ADR-002/003.
 * Run via `npm run architecture-check` (tsx).
 */
import fs from "fs";
import path from "path";

function globFiles(pattern: string, base = "src"): string[] {
  // simple glob without extra deps: use fs.readdir
  const out: string[] = [];
  function walk(dir: string) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx"))) out.push(p);
    }
  }
  if (fs.existsSync(base)) walk(base);
  // also include scripts
  return out;
}

type Layer = "domain" | "application" | "infrastructure" | "ui" | "unknown";

function layerOf(file: string): Layer {
  if (
    file.startsWith("src/lib/types") ||
    file.startsWith("src/lib/sitePersonas") ||
    file.startsWith("src/lib/normalizeOutput") ||
    file.startsWith("src/lib/transientErrors") ||
    file.startsWith("src/lib/config")
  )
    return "domain";
  if (
    file.startsWith("src/lib/personalization/resolve") ||
    file.startsWith("src/lib/personalization/prompts") ||
    file.startsWith("src/lib/personalization/sliders") ||
    file.startsWith("src/lib/personalization/canonical") ||
    file.startsWith("src/lib/personalization/types")
  ) {
    return "domain";
  }
  if (file.startsWith("src/lib/personalization/store") || file.startsWith("src/lib/personalization/index")) {
    return "application";
  }
  if (file.startsWith("src/lib/api")) return "application";
  if (
    file.startsWith("src/lib/storage") ||
    file.startsWith("src/lib/net") ||
    file.startsWith("src/lib/providers") ||
    file.startsWith("src/lib/auth") ||
    file.startsWith("src/lib/firebase") ||
    file.startsWith("src/lib/theme") ||
    file.includes("bridge") ||
    file.startsWith("src/entrypoints/background") ||
    file.startsWith("src/entrypoints/jot-host")
  )
    return "infrastructure";
  if (file.startsWith("src/entrypoints") || file.startsWith("src/components") || file.startsWith("src/hooks"))
    return "ui";
  return "unknown";
}

function readImports(file: string): string[] {
  const txt = fs.readFileSync(file, "utf8");
  const imps: string[] = [];
  const re = /import\s+[^;]*?from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt))) if (m[1]) imps.push(m[1]);
  const dyn = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dyn.exec(txt))) if (m[1]) imps.push(m[1]);
  return imps;
}

const files = globFiles("src");
let errors = 0;
let warns = 0;

for (const file of files) {
  const layer = layerOf(file);
  const imports = readImports(file);
  for (const imp of imports) {
    // Domain must not import infra/UI/chrome/react
    if (layer === "domain") {
      if (
        imp.includes("wxt/browser") ||
        imp.includes("chrome") ||
        (imp.includes("browser") && file.includes("sitePersonas"))
      ) {
        // sitePersonas etc should not import browser
        if (
          imp.includes("wxt") ||
          imp.includes("browser") ||
          imp.includes("firebase") ||
          imp.includes("react") ||
          imp.includes("storage") ||
          imp.includes("net") ||
          imp.includes("providers") ||
          imp.includes("auth")
        ) {
          console.error(`FAIL ${file} [domain] must not import ${imp}`);
          errors++;
        }
      }
      if (
        imp.includes("storage") ||
        imp.includes("net") ||
        imp.includes("providers") ||
        imp.includes("auth") ||
        imp.includes("firebase") ||
        imp === "react" ||
        imp.startsWith("react/")
      ) {
        // allow types import
        if (
          !imp.includes("types") &&
          !imp.includes("sitePersonas") &&
          !imp.includes("normalizeOutput") &&
          !imp.includes("transientErrors") &&
          !imp.includes("config")
        ) {
          console.error(`FAIL ${file} [domain] must not import infra ${imp}`);
          errors++;
        }
      }
    }
    // Application must not import UI (wxt/browser is infra, react is UI)
    if (layer === "application") {
      if (
        imp.includes("wxt/browser") ||
        imp === "react" ||
        imp.startsWith("react/") ||
        imp.includes("components") ||
        imp.includes("entrypoints")
      ) {
        console.error(`FAIL ${file} [application] must not import UI/infra ${imp}`);
        errors++;
      }
    }
    // Infrastructure must not import UI
    if (layer === "infrastructure") {
      if (
        imp.includes("components") ||
        (imp.includes("entrypoints") && !imp.includes("background") && !imp.includes("jot-host"))
      ) {
        console.error(`FAIL ${file} [infrastructure] must not import UI ${imp}`);
        errors++;
      }
    }
    // UI must not directly import persistence/http (storage/net/providers) - WARN for now per task
    if (layer === "ui") {
      const isStorage =
        imp.includes("@/lib/storage") || imp.includes("lib/storage") || imp === "./storage" || imp.endsWith("/storage");
      const isNet = imp.includes("lib/net") || imp.includes("@/lib/net");
      const isProviders = imp.includes("lib/providers");
      if (isStorage || isNet || isProviders) {
        console.warn(
          `WARN ${file} [ui] directly imports ${imp} — should go via application (api) (warn until Tasks 5-6)`,
        );
        warns++;
      }
    }
  }
}

// Domain re-export check: storage should not re-export sitePersonas
try {
  const storageTxt = fs.readFileSync("src/lib/storage.ts", "utf8");
  if (
    storageTxt.includes('from "./sitePersonas"') &&
    storageTxt.includes("export {") &&
    storageTxt.includes("matchesSite")
  ) {
    console.error(`FAIL src/lib/storage.ts re-exports sitePersonas (purified in task 2)`);
    errors++;
  }
} catch {}

// Overlay boot skeleton: first paint must precede the JS bundle, React,
// and the host handshake. index.html keeps a zero-JS glimmer (#jot-boot)
// that App removes on mount; no remote or inline scripts may gate it.
try {
  const html = fs.readFileSync("src/entrypoints/overlay/index.html", "utf8");
  if (!html.includes('id="jot-boot"')) {
    console.error(`FAIL src/entrypoints/overlay/index.html is missing the #jot-boot first-paint skeleton`);
    errors++;
  }
  // Strip comments: documentation may mention script tags without adding any.
  const markup = html.replace(/<!--[\s\S]*?-->/g, "");
  const scripts = markup.match(/<script[\s>]/g) ?? [];
  if (scripts.length !== 1 || !markup.includes('src="./main.tsx"')) {
    console.error(`FAIL src/entrypoints/overlay/index.html must contain only the local main.tsx module script`);
    errors++;
  }
  if (/<script[^>]*src\s*=\s*["']https?:/.test(html)) {
    console.error(`FAIL src/entrypoints/overlay/index.html loads a remote script (MV3 remotely-hosted-code ban)`);
    errors++;
  }
  const appTxt = fs.readFileSync("src/entrypoints/overlay/App.tsx", "utf8");
  if (!appTxt.includes('getElementById("jot-boot")')) {
    console.error(`FAIL src/entrypoints/overlay/App.tsx must remove #jot-boot on mount`);
    errors++;
  }
} catch {}

if (errors === 0) {
  if (warns > 0) console.log(`\nArchitecture check passed with ${warns} warn(s) (UI→storage allowed as warn).`);
  else console.log(`\nArchitecture check passed (no errors).`);
} else {
  console.error(`\nArchitecture check failed: ${errors} error(s), ${warns} warn(s)`);
}
process.exit(errors > 0 ? 1 : 0);
