
"use client";

import { MessageList } from "@/components/chat/MessageList";
import { MessageInput } from "@/components/chat/MessageInput";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { LogOut, Settings, Video, Copy, VideoOff, Phone, PhoneOff } from "lucide-react"; 
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

const GENERAL_CHAT_CALL_ID = "call_channel_general_chat";

type CallType = "video" | "audio";

export function ChatWindow() {
  const { currentUser, signOut } = useAuth();
  const { toast } = useToast();
  const [isCallActive, setIsCallActive] = useState(false);
  const [currentCallId, setCurrentCallId] = useState<string | null>(null);
  const [currentCallType, setCurrentCallType] = useState<CallType | null>(null);

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
    console.log("ChatWindow: handleEndCall triggered. Setting isCallActive to false.");
    setIsCallActive(false);
    setCurrentCallId(null);
    setCurrentCallType(null);
  }, []);

  const startCall = (type: CallType) => {
    if (isCallActive) {
      // If a call is already active, and the user clicks a call button,
      // it should effectively be an "end call" action if it's for the current type,
      // or potentially switch if we allowed that (not implemented).
      // For simplicity, any call button click while a call is active ends the current call.
      handleEndCall();
      if (type === currentCallType) return; // If ending the same type, don't restart
    }
    
    if (!currentUser) {
      toast({ variant: "destructive", title: "Login Required", description: "Please log in to start a call."});
      return;
    }
    
    const callId = GENERAL_CHAT_CALL_ID; // Use the fixed call ID for General Chat
    setCurrentCallId(callId);
    setCurrentCallType(type);
    setIsCallActive(true);
    console.log(`ChatWindow: Starting ${type} call with fixed ID:`, callId);
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
            onClick={() => startCall("audio")}
            aria-label={isCallActive && currentCallType === "audio" ? "End audio call" : "Start audio call"}
            disabled={!currentUser && !(isCallActive && currentCallType === "audio")}
            className={(isCallActive && currentCallType === "audio") ? "text-destructive hover:text-destructive/90 hover:bg-destructive/10" : ""}
          >
            {isCallActive && currentCallType === "audio" ? <PhoneOff className="h-5 w-5" /> : <Phone className="h-5 w-5" />}
          </Button>
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => startCall("video")}
            aria-label={isCallActive && currentCallType === "video" ? "End video call" : "Start video call"}
            disabled={!currentUser && !(isCallActive && currentCallType === "video")}
            className={(isCallActive && currentCallType === "video") ? "text-destructive hover:text-destructive/90 hover:bg-destructive/10" : ""}
          >
            {isCallActive && currentCallType === "video" ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
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
      
      {isCallActive && currentCallId && currentUser && currentCallType ? (
        <VideoCallView 
          callId={currentCallId} 
          onEndCall={handleEndCall} 
          localUser={currentUser}
          isAudioOnly={currentCallType === "audio"}
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
