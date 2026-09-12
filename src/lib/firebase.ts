/**
 * Firebase client init for Wurkflo sessions. Imported by the options page
 * AND the background service worker (the single owner of the persisted
 * session - see lib/auth.ts getWurkfloToken). Uses initializeAuth with
 * explicit IndexedDB persistence so the session survives service-worker
 * restarts; never used inside the cross-origin overlay iframe.
 */
import { type FirebaseApp, getApp, getApps, initializeApp } from "firebase/app";
import { type Auth, indexedDBLocalPersistence, initializeAuth } from "firebase/auth/web-extension";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

function getAppInstance(): FirebaseApp {
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

let _auth: Auth | null = null;

export function getFirebaseAuth(): Auth {
  if (!_auth) {
    _auth = initializeAuth(getAppInstance(), {
      persistence: [indexedDBLocalPersistence],
    });
  }
  return _auth;
}
