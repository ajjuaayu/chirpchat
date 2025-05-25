
"use client";

import { MessageList } from "@/components/chat/MessageList";
import { MessageInput } from "@/components/chat/MessageInput";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { LogOut, Settings, Video, Copy, VideoOff } from "lucide-react"; 
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useState, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { VideoCallView } from "./VideoCallView"; 

// Fixed call ID for the general chat room to allow easy testing
const GENERAL_CHAT_CALL_ID = "call_channel_general_chat";

export function ChatWindow() {
  const { currentUser, signOut } = useAuth();
  const { toast } = useToast();
  const [isVideoCallActive, setIsVideoCallActive] = useState(false);
  const [currentCallId, setCurrentCallId] = useState<string | null>(null);

  const chatTargetName = "General Chat"; 

  const handleShareAppLink = () => {
    if (typeof window !== "undefined") {
      navigator.clipboard.writeText(window.location.origin)
        .then(() => {
          toast({
            title: "Link Copied!",
            description: "App link copied to clipboard.",
          });
        })
        .catch(err => {
          console.error("Failed to copy: ", err);
          toast({
            variant: "destructive",
            title: "Failed to Copy",
            description: "Could not copy link to clipboard.",
          });
        });
    }
  };

  const handleEndCall = useCallback(() => {
    console.log("ChatWindow: handleEndCall triggered. Setting isVideoCallActive to false.");
    setIsVideoCallActive(false);
    setCurrentCallId(null);
    // VideoCallView's useEffect cleanup will handle Firestore and WebRTC cleanup.
  }, []);

  const toggleVideoCall = () => {
    if (isVideoCallActive) {
      // If call is active, onEndCall (which is handleEndCall here) will be triggered 
      // by VideoCallView when its end call button is clicked, or when it unmounts.
      // For an explicit stop from this button, we directly call handleEndCall.
      handleEndCall();
    } else {
      if (!currentUser) {
        toast({ variant: "destructive", title: "Login Required", description: "Please log in to start a video call."});
        return;
      }
      // Use the fixed call ID for General Chat
      const callId = GENERAL_CHAT_CALL_ID;
      setCurrentCallId(callId);
      setIsVideoCallActive(true);
      console.log("ChatWindow: Starting/Joining video call with fixed ID:", callId);
    }
  };

  return (
    <div className="flex flex-col h-full bg-background shadow-inner">
      <header className="flex items-center justify-between p-4 border-b border-border bg-card shadow-sm">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-foreground">{chatTargetName}</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={toggleVideoCall} 
            aria-label={isVideoCallActive ? "End video call" : "Start video call"}
            disabled={!currentUser && !isVideoCallActive} 
          >
            {isVideoCallActive ? <VideoOff className="h-5 w-5 text-destructive" /> : <Video className="h-5 w-5" />}
          </Button>
          {currentUser && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full">
                  <UserAvatar user={currentUser} className="h-9 w-9" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col space-y-1">
                    <p className="text-sm font-medium leading-none">{currentUser.displayName || "User"}</p>
                    <p className="text-xs leading-none text-muted-foreground">
                      {currentUser.email}
                    </p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleShareAppLink}>
                  <Copy className="mr-2 h-4 w-4" />
                  <span>Share App Link</span>
                </DropdownMenuItem>
                <DropdownMenuItem disabled> 
                  <Settings className="mr-2 h-4 w-4" />
                  <span>Settings</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={signOut} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Log out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>
      
      {isVideoCallActive && currentCallId && currentUser ? (
        <VideoCallView 
          callId={currentCallId} 
          onEndCall={handleEndCall} 
          localUser={currentUser} 
        />
      ) : (
        <>
          <MessageList />
          <MessageInput />
        </>
      )}
    </div>
  );
}
