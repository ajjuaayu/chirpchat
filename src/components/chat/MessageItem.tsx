
"use client";

import { UserAvatar } from "@/components/shared/UserAvatar";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Message, User } from "@/types";
import { formatDistanceToNow } from 'date-fns';
import { useAuth } from "@/contexts/AuthContext";
import { Phone, Video, AlertCircle, CheckCircle, XCircle } from "lucide-react"; // Added icons

interface MessageItemProps {
  message: Message;
}

export function MessageItem({ message }: MessageItemProps) {
  const { currentUser } = useAuth();
  const isSender = currentUser?.uid === message.userId;
  const isSystemMessage = message.userId === "system";

  const messageUser: Partial<User> = {
    uid: message.userId,
    displayName: message.userName,
    photoURL: message.userPhotoURL,
  };
  
  const timestamp = message.timestamp ? (message.timestamp as any).toDate ? (message.timestamp as any).toDate() : new Date(message.timestamp as any) : new Date();

  if (isSystemMessage && message.callDetails) {
    const { type, duration, status, callId } = message.callDetails;
    let IconComponent;
    let statusText = message.text; // Use the pre-formatted text from ChatWindow
    let iconColor = "text-muted-foreground";

    if (status === 'ended' || status === 'completed') {
      IconComponent = type === 'audio' ? Phone : Video;
      iconColor = "text-green-600 dark:text-green-500";
    } else if (status === 'missed') {
      IconComponent = AlertCircle;
      iconColor = "text-yellow-600 dark:text-yellow-500";
    } else if (status === 'declined_by_user') {
      IconComponent = XCircle;
      iconColor = "text-destructive";
    } else {
      IconComponent = type === 'audio' ? Phone : Video; // Default for other statuses
    }
    
    return (
      <div className="flex items-center justify-center gap-2 p-3 my-2 text-sm text-muted-foreground">
        {IconComponent && <IconComponent className={cn("h-4 w-4", iconColor)} />}
        <span>{statusText}</span>
        <span className="text-xs">({formatDistanceToNow(timestamp, { addSuffix: true })})</span>
      </div>
    );
  }

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
      {isSender && <UserAvatar user={currentUser as User} className="h-8 w-8 mt-1 flex-shrink-0" />}
    </div>
  );
}
