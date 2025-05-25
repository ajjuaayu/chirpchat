"use client";

import { UserAvatar } from "@/components/shared/UserAvatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import type { User } from "@/types";
import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { firestore } from "@/lib/firebase";
import { Skeleton } from "../ui/skeleton";

export function ActiveUserList() {
  const [activeUsers, setActiveUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // In a real app, you'd use Firebase Realtime Database or Firestore presence
    // For now, fetch users marked as active
    const usersRef = collection(firestore, "users");
    const q = query(usersRef, where("isActive", "==", true)); // This assumes an `isActive` field

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const users: User[] = [];
      snapshot.forEach((doc) => {
        users.push({ id: doc.id, ...doc.data() } as unknown as User); // Ensure proper type casting
      });
      setActiveUsers(users);
      setLoading(false);
    }, (error) => {
      console.error("Error fetching active users:", error);
      setLoading(false);
    });
    
    // Placeholder users if Firebase is not fully set up or no users are active
    if (usersRef === undefined) { // Basic check, ideally more robust
       const placeholderUsers: User[] = [
        { uid: '1', displayName: 'Alice Wonderland', email: 'alice@example.com', photoURL: 'https://placehold.co/100x100.png', isActive: true },
        { uid: '2', displayName: 'Bob The Builder', email: 'bob@example.com', photoURL: 'https://placehold.co/100x100.png', isActive: true },
        { uid: '3', displayName: 'Charlie Brown', email: 'charlie@example.com', photoURL: 'https://placehold.co/100x100.png', isActive: true },
      ];
      setActiveUsers(placeholderUsers);
      setLoading(false);
    }


    return () => unsubscribe();
  }, []);


  return (
    <div className="h-full flex flex-col">
      <h2 className="text-xl font-semibold p-4 border-b border-sidebar-border text-sidebar-foreground">Active Users</h2>
      <ScrollArea className="flex-1 p-2">
        {loading && (
          <div className="space-y-3 p-2">
            {[1,2,3].map(i => (
              <div key={i} className="flex items-center space-x-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="space-y-1">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading && activeUsers.length === 0 && (
          <p className="p-4 text-sm text-center text-sidebar-foreground/70">No active users.</p>
        )}
        <ul className="space-y-1">
          {activeUsers.map((user) => (
            <li key={user.uid}>
              <button className="flex items-center w-full gap-3 p-2 rounded-md hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors text-left">
                <UserAvatar user={user} className="h-10 w-10 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="truncate font-medium text-sm">{user.displayName || 'Anonymous User'}</p>
                  <p className="truncate text-xs text-sidebar-foreground/70">{user.email}</p>
                </div>
                <Badge variant="outline" className="bg-green-500/20 border-green-500 text-green-700 dark:text-green-400 text-xs px-1.5 py-0.5">
                   Online
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  );
}
