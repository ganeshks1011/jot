import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { setPendingLinkCode } from "@/lib/storage";

/**
 * Landing page for the web-to-extension auth handoff. The Wurkflo web app
 * redirects here with a single-use link code in the URL fragment (never a
 * query string, so it never hits network logs). We park the code in
 * chrome.storage.local for the options page to consume, strip it from the
 * address bar, show a success screen, and try to auto-close the tab.
 */
export default function App() {
  const [state, setState] = useState<"working" | "done" | "error">("working");
  const [detail, setDetail] = useState("");

  useEffect(() => {
    const hash = window.location.hash;
    // Strip the code from the address bar/history entry immediately.
    window.history.replaceState(null, "", window.location.pathname);

    const match = /^#code=([a-f0-9]{32})$/.exec(hash);
    if (!match?.[1]) {
      setDetail("No connection code was found in this tab's address. Start again from Jot's settings.");
      setState("error");
      return;
    }

    void setPendingLinkCode(match[1])
      .then(() => setState("done"))
      .catch(() => {
        setDetail("Could not save the connection code. Start again from Jot's settings.");
        setState("error");
      });
  }, []);

  // The tab is opened via tabs.create() by the options page, so window.close()
  // is permitted; if the browser refuses, the success screen stays visible.
  useEffect(() => {
    if (state !== "done") return;
    const t = setTimeout(() => window.close(), 2500);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm text-center">
        {state === "working" && <p className="text-sm text-muted">Finishing the connection...</p>}

        {state === "done" && (
          <>
            <CheckCircle2 className="mx-auto mb-4 size-12 text-success" />
            <h1 className="text-lg font-semibold tracking-tight">Account linked successfully!</h1>
            <p className="mt-2 text-sm text-muted">You can close this tab and return to Jot.</p>
          </>
        )}

        {state === "error" && (
          <>
            <XCircle className="mx-auto mb-4 size-12 text-danger" />
            <h1 className="text-lg font-semibold tracking-tight">Connection failed</h1>
            <p className="mt-2 text-sm text-muted">{detail}</p>
          </>
        )}
      </div>
    </main>
  );
}
