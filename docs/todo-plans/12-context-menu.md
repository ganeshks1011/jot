# Todo 12 — Add context menu to open Jot

**Status:** available — `project.md:12`

## Goal
Right-click `Rewrite with Jot` on editable/selection to open overlay like shortcut.

## Files
- `wxt.config.ts:38` add `contextMenus` to `permissions`
- `src/entrypoints/background.ts:65` `onInstalled`/`onStartup` create menu, `onClicked` → `activateJot()`

## Steps
1. `permissions: ["storage","activeTab","scripting","contextMenus"]`
2. In `defineBackground` add `setupContextMenu()`:
   `chrome.contextMenus.removeAll(); chrome.contextMenus.create({id:"open-jot", title:"Rewrite with Jot", contexts:["editable","selection"], documentUrlPatterns:["http://*/*","https://*/*"]})`
3. `chrome.contextMenus.onClicked` → if `open-jot` → `activateJot()` (reuse activeTab grant, no new injection)
4. `npm run typecheck && build` → manifest shows perm, no host perms
5. Manual: Gmail compose right-click shows item, click opens overlay anchored

## Verification
- Fresh install → right-click editable shows `Rewrite with Jot`, non-editable `chrome://` no item, click opens overlay
- Shortcut still works, no duplicate menu on reload (removeAll)
