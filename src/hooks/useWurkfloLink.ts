import { useCallback, useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { completeWurkfloLink, extensionAuthUrl, signOutWurkflo, watchWurkfloAuth } from "@/lib/auth";
import { clearPendingLinkCode, getPendingLinkCode, watchPendingLinkCode } from "@/lib/storage";

export function useWurkfloLink() {
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const finishLink = async (code: string) => {
      if (cancelled) return;
      setLinking(true);
      setLinkError(null);
      try {
        await clearPendingLinkCode();
        await completeWurkfloLink(code);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Could not connect";
          setLinkError(/expired|already used|not valid/i.test(msg) ? "The request expired. Click Connect again." : msg);
        }
      } finally {
        if (!cancelled) setLinking(false);
      }
    };
    void getPendingLinkCode().then((code) => {
      if (code) void finishLink(code);
    });
    const unsub = watchPendingLinkCode((code) => {
      if (code) void finishLink(code);
    });
    const unsubAuth = watchWurkfloAuth();
    return () => {
      cancelled = true;
      unsub();
      unsubAuth();
    };
  }, []);

  const handleConnect = useCallback(() => {
    setLinkError(null);
    void browser.tabs.create({ url: extensionAuthUrl(browser.runtime.id) });
  }, []);

  const handleSignOut = useCallback(async () => {
    setLinkError(null);
    await signOutWurkflo();
  }, []);

  return { linking, linkError, setLinkError, handleConnect, handleSignOut };
}
