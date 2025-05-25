"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { SendHorizonal, Loader2 } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { firestore } from "@/lib/firebase";

export function MessageInput() {
  const [message, setMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const { toast } = useToast();
  const { currentUser } = useAuth();

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || !currentUser) return;

    setIsSending(true);
    try {
      await addDoc(collection(firestore, "messages"), {
        text: message.trim(),
        userId: currentUser.uid,
        userName: currentUser.displayName,
        userPhotoURL: currentUser.photoURL,
        timestamp: serverTimestamp(),
      });
      setMessage("");
    } catch (error) {
      console.error("Error sending message:", error);
      toast({
        variant: "destructive",
        title: "Send Error",
        description: "Could not send message. Please try again.",
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <form 
      onSubmit={handleSendMessage} 
      className="flex items-center gap-3 p-4 border-t border-border bg-card"
    >
      <Input
        type="text"
        placeholder="Type a message..."
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        className="flex-1 rounded-full px-4 py-2 focus-visible:ring-primary focus-visible:ring-offset-0"
        disabled={isSending || !currentUser}
        aria-label="Message input"
      />
      <Button 
        type="submit" 
        size="icon" 
        className="rounded-full bg-primary hover:bg-primary/90 text-primary-foreground w-10 h-10"
        disabled={isSending || !message.trim() || !currentUser}
        aria-label="Send message"
      >
        {isSending ? <Loader2 className="h-5 w-5 animate-spin" /> : <SendHorizonal className="h-5 w-5" />}
      </Button>
    </form>
  );
}
