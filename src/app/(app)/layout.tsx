"use client";

import { ActiveUserList } from "@/components/chat/ActiveUserList";
import { Logo } from "@/components/shared/Logo";
import { useAuth } from "@/contexts/AuthContext";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import React, { useEffect } from "react";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { currentUser, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !currentUser) {
      router.replace('/auth');
    }
  }, [currentUser, loading, router]);

  if (loading || (!loading && !currentUser)) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }
  
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <aside className="hidden md:flex flex-col w-72 bg-sidebar-background border-r border-sidebar-border shadow-lg">
        <div className="p-4 border-b border-sidebar-border">
          <Logo size="md" />
        </div>
        <ActiveUserList />
      </aside>
      <main className="flex-1 flex flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}
