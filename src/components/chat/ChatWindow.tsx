
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
import { useState, useCallback, useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { VideoCallView } from "./VideoCallView"; 
import type { CallType, CallDocument as FirestoreCallDocument } from "@/types"; // Updated import
import { firestore } from "@/lib/firebase";
import { doc, onSnapshot, updateDoc, serverTimestamp, addDoc, collection, Unsubscribe } from "firebase/firestore";
import { IncomingCallDialog } from "./IncomingCallDialog";


const GENERAL_CHAT_AUDIO_CALL_ID = "call_channel_general_chat_audio";
const GENERAL_CHAT_VIDEO_CALL_ID = "call_channel_general_chat_video";

export function ChatWindow() {
  const { currentUser, signOut } = useAuth();
  const { toast } = useToast();

  const [isCallActive, setIsCallActive] = useState(false);
  const [currentCallId, setCurrentCallId] = useState<string | null>(null);
  const [currentCallType, setCurrentCallType] = useState<CallType | null>(null);

  const [incomingCallData, setIncomingCallData] = useState<{ callId: string; callerName?: string | null; isAudioOnly: boolean; } | null>(null);
  const [showIncomingCallDialog, setShowIncomingCallDialog] = useState(false);

  const callListenersRef = useRef<Unsubscribe[]>([]);


  const logCallEventToChat = useCallback(async (
    callId: string,
    type: CallType,
    status: 'completed' | 'missed' | 'declined_by_user' | 'ended',
    duration?: number 
  ) => {
    if (!currentUser) return;

    let text = "";
    if (status === 'ended' || status === 'completed') {
      const durationFormatted = duration ? `${Math.floor(duration / 60)}m ${Math.round(duration % 60)}s` : 'unknown duration';
      text = `${type === 'audio' ? 'Audio' : 'Video'} call ended. Duration: ${durationFormatted}`;
    } else if (status === 'missed') {
      text = `${type === 'audio' ? 'Audio' : 'Video'} call missed.`;
    } else if (status === 'declined_by_user') {
      text = `${type === 'audio' ? 'Audio' : 'Video'} call declined.`;
    }
    
    try {
      await addDoc(collection(firestore, "messages"), {
        text: text,
        userId: "system", // Special ID for system messages
        userName: "Call Notification",
        userPhotoURL: null, 
        timestamp: serverTimestamp(),
        callDetails: {
          type: type,
          duration: duration,
          status: status,
          callId: callId,
        },
      });
    } catch (error) {
      console.error("Error logging call to chat:", error);
      toast({ variant: "destructive", title: "Error", description: "Could not log call event." });
    }
  }, [currentUser, toast]);

  const handleEndCall = useCallback(async (callIdEnded?: string, callTypeEnded?: CallType, duration?: number) => {
    console.log("ChatWindow: handleEndCall triggered. Setting isCallActive to false.");
    setIsCallActive(false);
    
    if (callIdEnded && callTypeEnded) {
        // The VideoCallView component will handle primary Firestore updates for 'ended_by_caller/callee'
        // This log is more for the chat message.
        logCallEventToChat(callIdEnded, callTypeEnded, 'ended', duration);
    }
    
    setCurrentCallId(null);
    setCurrentCallType(null);
  }, [logCallEventToChat]);


  useEffect(() => {
    if (!currentUser) {
      callListenersRef.current.forEach(unsub => unsub());
      callListenersRef.current = [];
      return;
    }

    const callIdsToListen = [GENERAL_CHAT_AUDIO_CALL_ID, GENERAL_CHAT_VIDEO_CALL_ID];
    
    callListenersRef.current.forEach(unsub => unsub()); // Clear existing listeners
    callListenersRef.current = [];

    callIdsToListen.forEach(callId => {
      const callDocRef = doc(firestore, "calls", callId);
      const unsubscribe = onSnapshot(callDocRef, (snapshot) => {
        const callData = snapshot.data() as FirestoreCallDocument | undefined;
        if (callData && callData.status === 'ringing' && callData.callerId !== currentUser.uid && !isCallActive && !showIncomingCallDialog) {
          // Basic check to avoid self-notifying or if already in a call or dialog is shown.
          // More complex logic would be needed to handle if user rejected this specific offer instance before.
          setIncomingCallData({
            callId: snapshot.id,
            callerName: callData.callerName,
            isAudioOnly: callData.isAudioOnly,
          });
          setShowIncomingCallDialog(true);
        } else if (!callData || callData.status !== 'ringing') {
          // If the call is no longer ringing (e.g., accepted by someone else, ended, or deleted),
          // and if the current incoming call dialog matches this callId, close it.
          if (incomingCallData && incomingCallData.callId === snapshot.id) {
            setShowIncomingCallDialog(false);
            setIncomingCallData(null);
          }
        }
      });
      callListenersRef.current.push(unsubscribe);
    });
    
    return () => {
      callListenersRef.current.forEach(unsub => unsub());
      callListenersRef.current = [];
    };

  }, [currentUser, isCallActive, showIncomingCallDialog, incomingCallData]);


  const handleAcceptCall = async () => {
    if (!incomingCallData || !currentUser) return;

    const callDocRef = doc(firestore, "calls", incomingCallData.callId);
    try {
      await updateDoc(callDocRef, {
        calleeId: currentUser.uid,
        calleeName: currentUser.displayName || "Anonymous",
        status: 'active',
        joinedAt: serverTimestamp(),
      });
      
      setCurrentCallId(incomingCallData.callId);
      setCurrentCallType(incomingCallData.isAudioOnly ? 'audio' : 'video');
      setIsCallActive(true);

      setShowIncomingCallDialog(false);
      setIncomingCallData(null);
    } catch (error) {
      console.error("Error accepting call:", error);
      toast({ variant: "destructive", title: "Error", description: "Could not accept call." });
      setShowIncomingCallDialog(false);
      setIncomingCallData(null);
    }
  };

  const handleRejectCall = async () => {
    if (!incomingCallData || !currentUser) return;
    
    // For general call IDs, "rejecting" means this user won't join.
    // If the call was directly to this user, we'd update Firestore status.
    // For now, primarily local dismissal for general calls.
    // We can log a "declined_by_user" to chat for this user.
    logCallEventToChat(incomingCallData.callId, incomingCallData.isAudioOnly ? 'audio' : 'video', 'declined_by_user');

    setShowIncomingCallDialog(false);
    setIncomingCallData(null);
    // Optionally, if we want to signify rejection more strongly on Firestore for a general call:
    // const callDocRef = doc(firestore, "calls", incomingCallData.callId);
    // await updateDoc(callDocRef, { status: 'ended' }); // Or a specific 'rejected' status
  };


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

  const startCall = (type: CallType) => {
    if (isCallActive && currentCallType === type && currentCallId === (type === "audio" ? GENERAL_CHAT_AUDIO_CALL_ID : GENERAL_CHAT_VIDEO_CALL_ID) ) {
      // User is clicking the button for the currently active call of this type, so end it.
      // VideoCallView's onEndCall will handle cleanup and logging.
      // We just need to ensure VideoCallView's end call mechanism is triggered.
      // This is typically done by VideoCallView itself when user clicks its end call button.
      // If we want ChatWindow's button to also end it, VideoCallView needs a prop to trigger its internal end.
      // For now, assume VideoCallView's button is the primary way to end.
      // To make this button also end the call, we'd need VideoCallView to expose a "hangup" function via a ref, or handleEndCall directly.
      // The current structure calls handleEndCall from VideoCallView. So, nothing direct to do here to end an *active* call.
      // User should use VideoCallView's end button.
      // If user is trying to start a NEW call of same type while one is active: This is handled by VideoCallView's busy check.
      return;
    }
    
    if (isCallActive && currentCallType !== type) {
        // User is in a call of one type (e.g. audio) and clicks to start another type (e.g. video)
        // For simplicity, we can prevent this or choose to end the current call first.
        // Let's prevent starting a new type of call if one is already active.
        toast({ variant: "destructive", title: "Call In Progress", description: `Please end your current ${currentCallType} call before starting a new one.`});
        return;
    }
    
    if (!currentUser) {
      toast({ variant: "destructive", title: "Login Required", description: "Please log in to start a call."});
      return;
    }
    
    const callId = type === "audio" ? GENERAL_CHAT_AUDIO_CALL_ID : GENERAL_CHAT_VIDEO_CALL_ID;
    
    // Caller flow:
    // VideoCallView will handle creating the call document in Firestore if it doesn't exist or is stale.
    setCurrentCallId(callId);
    setCurrentCallType(type);
    setIsCallActive(true); // This will mount VideoCallView
    console.log(`ChatWindow: Starting ${type} call with ID:`, callId);
  };

  return (
    <>
      <IncomingCallDialog
        open={showIncomingCallDialog && !!incomingCallData}
        onOpenChange={setShowIncomingCallDialog}
        callerName={incomingCallData?.callerName}
        isAudioOnly={incomingCallData?.isAudioOnly || false}
        onAccept={handleAcceptCall}
        onReject={handleRejectCall}
      />
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
              aria-label={isCallActive && currentCallType === "audio" ? "Audio call active" : "Start audio call"}
              disabled={!currentUser || (isCallActive && currentCallType === "video")}
              className={(isCallActive && currentCallType === "audio") ? "text-destructive hover:text-destructive/90 hover:bg-destructive/10" : ""}
            >
              {isCallActive && currentCallType === "audio" ? <PhoneOff className="h-5 w-5" /> : <Phone className="h-5 w-5" />}
            </Button>
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => startCall("video")}
              aria-label={isCallActive && currentCallType === "video" ? "Video call active" : "Start video call"}
              disabled={!currentUser || (isCallActive && currentCallType === "audio")}
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
        
        {isCallActive && currentCallId && currentUser && currentCallType !== null ? (
          <VideoCallView 
            key={currentCallId} 
            callId={currentCallId} 
            onEndCall={(duration) => handleEndCall(currentCallId, currentCallType, duration)} 
            localUser={currentUser}
            isAudioOnly={currentCallType === "audio"}
            logCallEventToChat={logCallEventToChat} // Pass the logging function
          />
        ) : (
          <>
            <MessageList />
            <MessageInput />
          </>
        )}
      </div>
    </>
  );
}
