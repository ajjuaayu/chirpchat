"use client";

import { UserAvatar } from "@/components/shared/UserAvatar";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Message, User } from "@/types";
import { formatDistanceToNow } from 'date-fns';
import { useAuth } from "@/contexts/AuthContext";

interface MessageItemProps {
  message: Message;
}

export function MessageItem({ message }: MessageItemProps) {
  const { currentUser } = useAuth();
  const isSender = currentUser?.uid === message.userId;

  // Create a User-like object for UserAvatar from message details
  const messageUser: Partial<User> = {
    uid: message.userId,
    displayName: message.userName,
    photoURL: message.userPhotoURL,
  };
  
  const timestamp = message.timestamp ? (message.timestamp as any).toDate ? (message.timestamp as any).toDate() : new Date(message.timestamp as any) : new Date();


  return (
    <div className={cn(
      "flex items-start gap-3 p-3 animate-in fade-in slide-in-from-bottom-5 duration-300",
      isSender ? "justify-end" : "justify-start"
    )}>
      {!isSender && <UserAvatar user={messageUser as User} className="h-8 w-8 mt-1 flex-shrink-0" />}
      <div className={cn(
        "flex flex-col max-w-[70%]",
        isSender ? "items-end" : "items-start"
      )}>
        <Card className={cn(
          "rounded-xl shadow-md",
          isSender ? "bg-primary text-primary-foreground rounded-br-none" : "bg-card text-card-foreground rounded-bl-none"
        )}>
          <CardContent className="p-3">
            {!isSender && (
              <p className="text-xs font-medium mb-1 opacity-80">
                {message.userName || "Anonymous"}
              </p>
            )}
            <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground mt-1 px-1">
          {formatDistanceToNow(timestamp, { addSuffix: true })}
        </p>
      </div>
      {isSender && <UserAvatar user={currentUser} className="h-8 w-8 mt-1 flex-shrink-0" />}
    </div>
  );
}
