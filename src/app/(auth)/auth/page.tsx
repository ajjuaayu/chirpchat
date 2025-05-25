"use client";

import { EmailLoginForm } from "@/components/auth/EmailLoginForm";
import { GoogleLoginButton } from "@/components/auth/GoogleLoginButton";
import { Logo } from "@/components/shared/Logo";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/contexts/AuthContext";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";


export default function AuthPage() {
  const { currentUser, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && currentUser) {
      router.replace("/chat");
    }
  }, [currentUser, loading, router]);

  if (loading || (!loading && currentUser)) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <Card className="w-full max-w-md shadow-2xl bg-card/80 backdrop-blur-sm">
      <CardHeader className="text-center">
        <div className="mx-auto mb-6">
          <Logo size="lg" />
        </div>
        <CardTitle className="text-3xl font-bold">Welcome to Chirp Chat</CardTitle>
        <CardDescription className="text-muted-foreground">
          Connect and chat in real-time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 p-6 sm:p-8">
        <EmailLoginForm />
        <div className="relative my-6">
          <Separator className="absolute left-0 top-1/2 -translate-y-1/2 w-full" />
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs uppercase text-muted-foreground">
            Or
          </span>
        </div>
        <GoogleLoginButton />
      </CardContent>
    </Card>
  );
}
