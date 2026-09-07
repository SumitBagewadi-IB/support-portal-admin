import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) {
  initializeApp();
}

// Connect to the named Firestore database
const db = getFirestore("support-portal-faqs");

export { db };
