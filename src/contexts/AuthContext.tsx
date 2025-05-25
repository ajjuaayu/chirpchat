
"use client";

import type { User as FirebaseUser } from 'firebase/auth';
import { onAuthStateChanged, signOut as firebaseSignOut } from 'firebase/auth';
import { useRouter, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { auth, firestore } from '@/lib/firebase';
import type { User } from '@/types';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import { Loader2 } from 'lucide-react';

interface AuthContextType {
  currentUser: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser: FirebaseUser | null) => {
      // Set loading to true at the beginning of handling auth state change.
      // This ensures UI shows loading state until profile is fetched/created or auth state is cleared.
      setLoading(true); 
      if (firebaseUser) {
        try {
          const userRef = doc(firestore, "users", firebaseUser.uid);
          const userSnap = await getDoc(userRef);
          let userData: User | null = null;

          if (!userSnap.exists()) {
            // Create user document if it doesn't exist
            const newUser: User = {
              uid: firebaseUser.uid,
              email: firebaseUser.email,
              displayName: firebaseUser.displayName,
              photoURL: firebaseUser.photoURL,
              isActive: true, // Set initial active state
            };
            await setDoc(userRef, newUser);
            userData = newUser;
          } else {
            userData = userSnap.data() as User;
          }
          setCurrentUser(userData);
          
          if (pathname === '/auth' || pathname === '/') {
            router.replace('/chat');
          }
        } catch (error) {
          console.error("Error fetching/creating user profile in Firestore:", error);
          // Sign out the user if there's an error with their profile data
          // This will trigger onAuthStateChanged again with firebaseUser = null
          await firebaseSignOut(auth); 
          setCurrentUser(null); // Explicitly set, though onAuthStateChanged will handle redirection
        }
      } else {
        setCurrentUser(null);
        if (pathname !== '/auth' && pathname !== '/') { // Also allow landing on root page if not logged in
          router.replace('/auth');
        }
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, [router, pathname]);

  const signOut = async () => {
    setLoading(true); // Optional: show loader during sign out
    try {
      // Update user's isActive status to false in Firestore before signing out
      if (currentUser) {
        const userRef = doc(firestore, "users", currentUser.uid);
        await setDoc(userRef, { isActive: false }, { merge: true });
      }
    } catch (error) {
      console.error("Error updating user status on sign out:", error);
      // Proceed with sign out even if updating status fails
    }
    await firebaseSignOut(auth);
    setCurrentUser(null); // This will be updated by onAuthStateChanged, but good for immediate UI
    router.push('/auth');
    // setLoading(false) will be handled by onAuthStateChanged
  };

  // Initial loading state covering the very first auth check
  if (loading && typeof window !== 'undefined' && auth.currentUser === undefined) {
     return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }


  return (
    <AuthContext.Provider value={{ currentUser, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
