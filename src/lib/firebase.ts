import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, Auth } from 'firebase/auth';
import { getFirestore, Firestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyDPhcCD1uXqNR_gQfC1E_WOxVnw2BMgaAw",
  authDomain: "alltesting-2b8ff.firebaseapp.com",
  projectId: "alltesting-2b8ff",
  storageBucket: "alltesting-2b8ff.appspot.com", // Corrected common mistake from firebasestorage.app to appspot.com for storageBucket
  messagingSenderId: "238857998191",
  appId: "1:238857998191:web:0d81c7813c000a5017a29a",
  measurementId: "G-6XWHK6MX0X"
};

let app: FirebaseApp;
if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApp();
}

const auth: Auth = getAuth(app);
const firestore: Firestore = getFirestore(app);
const googleProvider: GoogleAuthProvider = new GoogleAuthProvider();

export { app, auth, firestore, googleProvider };
