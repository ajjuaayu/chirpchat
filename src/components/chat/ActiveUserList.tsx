
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
    const usersRef = collection(firestore, "users");
    // Query for users explicitly marked as active.
    // This requires an `isActive` field (boolean) in your user documents.
    const q = query(usersRef, where("isActive", "==", true)); 

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const users: User[] = [];
      snapshot.forEach((doc) => {
        // Ensure proper type casting and that an id is included
        users.push({ uid: doc.id, ...doc.data() } as User); 
      });
      setActiveUsers(users);
      setLoading(false);
    }, (error) => {
      console.error("Error fetching active users:", error);
      // Potentially set an error state here to inform the user
      setActiveUsers([]); // Clear users on error
      setLoading(false);
    });

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
          <p className="p-4 text-sm text-center text-sidebar-foreground/70">No active users currently online.</p>
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
