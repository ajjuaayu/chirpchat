
"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Mic, MicOff, PhoneOff, Video, VideoOff, Loader2, User as UserIcon } from "lucide-react"; // Added UserIcon
import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useAuth } from "@/contexts/AuthContext";
import { doc, onSnapshot, setDoc, updateDoc, collection, addDoc, getDoc, deleteDoc, serverTimestamp, query, where, getDocs, writeBatch, Timestamp } from "firebase/firestore";
import { firestore } from "@/lib/firebase";
import type { User as AuthUser } from "@/types";

interface VideoCallViewProps {
  callId: string;
  onEndCall: () => void;
  localUser: AuthUser | null; // Added localUser prop
}

// Standard public STUN servers
const stunServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function VideoCallView({ callId, onEndCall, localUser }: VideoCallViewProps) {
  const { toast } = useToast();

  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [hasMediaPermission, setHasMediaPermission] = useState<boolean | null>(null);
  const [isConnecting, setIsConnecting] = useState(true);
  const [isCaller, setIsCaller] = useState<boolean | null>(null); // To track if current user is the caller

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  const iceCandidateListenersUnsubscribeRef = useRef<(() => void)[]>([]);


  const cleanupCall = useCallback(async () => {
    console.log("Cleaning up call resources for callId:", callId);
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }
    if (peerConnection) {
      peerConnection.close();
      setPeerConnection(null);
    }
    setRemoteStream(null);

    // Stop listening to ICE candidate changes
    iceCandidateListenersUnsubscribeRef.current.forEach(unsubscribe => unsubscribe());
    iceCandidateListenersUnsubscribeRef.current = [];

    // Firestore cleanup
    if (localUser && callId) {
      const callDocRef = doc(firestore, 'calls', callId);
      try {
        const callDocSnap = await getDoc(callDocRef);
        if (callDocSnap.exists()) {
          // If this user is the caller or if no callee joined, delete the whole call document and subcollections
          // This is a simplified cleanup. In a real app, you might just update status.
          if (callDocSnap.data().callerId === localUser.uid || !callDocSnap.data().calleeId) {
            console.log("Deleting call document and subcollections for callId:", callId);
            const batch = writeBatch(firestore);
            
            const callerCandidatesQuery = query(collection(firestore, `calls/${callId}/callerCandidates`));
            const callerCandidatesSnap = await getDocs(callerCandidatesQuery);
            callerCandidatesSnap.forEach(doc => batch.delete(doc.ref));
            
            const calleeCandidatesQuery = query(collection(firestore, `calls/${callId}/calleeCandidates`));
            const calleeCandidatesSnap = await getDocs(calleeCandidatesQuery);
            calleeCandidatesSnap.forEach(doc => batch.delete(doc.ref));
            
            batch.delete(callDocRef);
            await batch.commit();
            console.log("Call document and subcollections deleted.");
          } else if (callDocSnap.data().calleeId === localUser.uid) {
            // If this user is the callee, they could just "leave" by clearing their ID or updating status
            await updateDoc(callDocRef, { status: 'ended_by_callee', [`callee_${localUser.uid}_leftAt`]: serverTimestamp() });
            console.log("Callee left call, updated status for callId:", callId);
          }
        }
      } catch (error) {
        console.error("Error cleaning up call document:", error);
      }
    }
  }, [localStream, peerConnection, localUser, callId]);

  // Initialize Peer Connection and Media
  useEffect(() => {
    let callDocUnsubscribe: (() => void) | null = null;
    let pcInstance: RTCPeerConnection | null = null;

    const initialize = async () => {
      if (!localUser) {
        toast({ variant: "destructive", title: "Authentication Error", description: "User not found."});
        onEndCall();
        return;
      }
       setIsConnecting(true);

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        setLocalStream(stream);
        setHasMediaPermission(true);
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        pcInstance = new RTCPeerConnection(stunServers);
        setPeerConnection(pcInstance);

        stream.getTracks().forEach(track => pcInstance!.addTrack(track, stream));

        pcInstance.onicecandidate = event => {
          if (event.candidate && callId) {
            console.log("Generated ICE candidate:", event.candidate.toJSON());
            const candidatesCollection = isCaller ? `calls/${callId}/callerCandidates` : `calls/${callId}/calleeCandidates`;
            addDoc(collection(firestore, candidatesCollection), event.candidate.toJSON())
              .catch(e => console.error("Error adding ICE candidate to Firestore:", e));
          }
        };

        pcInstance.ontrack = event => {
          console.log("Received remote track:", event.streams[0]);
          if (event.streams && event.streams[0]) {
            setRemoteStream(event.streams[0]);
            if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = event.streams[0];
            }
            setIsConnecting(false); 
          }
        };
        
        pcInstance.onconnectionstatechange = () => {
          console.log("Peer connection state:", pcInstance?.connectionState);
          if (pcInstance?.connectionState === 'connected') {
            setIsConnecting(false);
          } else if (['disconnected', 'failed', 'closed'].includes(pcInstance?.connectionState || '')) {
            setIsConnecting(false);
            // Consider if call should end here automatically for certain states
            // onEndCall(); 
          }
        };

        // Signaling logic
        const callDocRef = doc(firestore, 'calls', callId);
        const callDocSnap = await getDoc(callDocRef);

        if (!callDocSnap.exists()) { // This user is the caller
          setIsCaller(true);
          const offerDescription = await pcInstance.createOffer();
          await pcInstance.setLocalDescription(offerDescription);

          const callData = {
            callerId: localUser.uid,
            callerName: localUser.displayName || "Anonymous Caller",
            offer: {
              type: offerDescription.type,
              sdp: offerDescription.sdp,
            },
            status: 'ringing',
            createdAt: serverTimestamp(),
          };
          await setDoc(callDocRef, callData);
          console.log("Caller: Created offer and call document", callId);

          // Listen for callee's ICE candidates
          const calleeCandidatesCollection = collection(firestore, `calls/${callId}/calleeCandidates`);
          const unsubCalleeCandidates = onSnapshot(calleeCandidatesCollection, snapshot => {
            snapshot.docChanges().forEach(change => {
              if (change.type === 'added') {
                const candidate = new RTCIceCandidate(change.doc.data());
                pcInstance?.addIceCandidate(candidate).catch(e => console.error("Error adding callee ICE candidate:", e));
                console.log("Caller: Added callee ICE candidate");
              }
            });
          });
          iceCandidateListenersUnsubscribeRef.current.push(unsubCalleeCandidates);

        } else { // This user is the callee
          setIsCaller(false);
          const callData = callDocSnap.data();
          if (callData.offer && callData.callerId !== localUser.uid && callData.status === 'ringing') {
            await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.offer));
            
            const answerDescription = await pcInstance.createAnswer();
            await pcInstance.setLocalDescription(answerDescription);

            const answerData = {
              calleeId: localUser.uid,
              calleeName: localUser.displayName || "Anonymous Callee",
              answer: {
                type: answerDescription.type,
                sdp: answerDescription.sdp,
              },
              status: 'active',
              joinedAt: serverTimestamp(),
            };
            await updateDoc(callDocRef, answerData);
            console.log("Callee: Set remote offer, created answer, and updated call document", callId);
            setIsConnecting(false); // Callee is connected once answer is sent

            // Listen for caller's ICE candidates
            const callerCandidatesCollection = collection(firestore, `calls/${callId}/callerCandidates`);
            const unsubCallerCandidates = onSnapshot(callerCandidatesCollection, snapshot => {
              snapshot.docChanges().forEach(change => {
                if (change.type === 'added') {
                  const candidate = new RTCIceCandidate(change.doc.data());
                  pcInstance?.addIceCandidate(candidate).catch(e => console.error("Error adding caller ICE candidate:", e));
                  console.log("Callee: Added caller ICE candidate");
                }
              });
            });
            iceCandidateListenersUnsubscribeRef.current.push(unsubCallerCandidates);

          } else if (callData.callerId === localUser.uid) {
            // This edge case: user re-opened the call they initiated.
            // Could resume or show "waiting for callee". For now, just log.
            console.log("Caller re-joined/re-opened their own call window for callId:", callId);
            setIsCaller(true); // Ensure isCaller is set correctly
            // If callData.answer exists, it means someone joined, attempt to re-establish
             if (callData.answer && pcInstance.signalingState !== 'stable') {
                await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.answer));
                console.log("Caller: Re-set remote answer on re-join.");
                setIsConnecting(false);
             }
          } else {
             console.warn("Call document exists, but state is unexpected or already joined by another callee for callId:", callId, callData);
             toast({variant: "destructive", title: "Call Error", description: "Call is already in progress or in an invalid state."});
             onEndCall();
             return;
          }
        }

        // General listener for call document changes (e.g., caller waiting for answer, or call ended by other party)
        callDocUnsubscribe = onSnapshot(callDocRef, async (snapshot) => {
          const data = snapshot.data();
          if (!data) { // Document deleted, call ended
            console.log("Call document deleted, call ended for callId:", callId);
            toast({title: "Call Ended", description: "The other user has ended the call."});
            onEndCall(); // Ensure cleanup happens via onEndCall -> cleanupCall
            return;
          }

          // Caller logic: if an answer appears
          if (isCaller && data.answer && pcInstance?.signalingState !== 'stable') {
            try {
                await pcInstance.setRemoteDescription(new RTCSessionDescription(data.answer));
                console.log("Caller: Set remote answer from Firestore for callId:", callId);
                setIsConnecting(false);
            } catch (e) {
                console.error("Caller: Error setting remote answer:", e);
            }
          }

          if (data.status === 'ended' || data.status === 'ended_by_caller' || data.status === 'ended_by_callee') {
            if ((isCaller && data.status === 'ended_by_callee') || (!isCaller && data.status === 'ended_by_caller') || data.status === 'ended') {
                console.log("Call ended by other party or explicitly for callId:", callId);
                toast({title: "Call Ended", description: "The call has ended."});
                onEndCall(); // Triggers cleanup
            }
          }
        });

      } catch (error) {
        console.error('Error initializing video call:', error);
        setHasMediaPermission(false);
        let description = 'Please enable camera and microphone permissions in your browser settings.';
        if (error instanceof Error) {
          if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            description = 'Camera and microphone access was denied. Please enable it in your browser settings and refresh.';
          } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
            description = 'No camera or microphone found. Please ensure they are connected and enabled.';
          }
        }
        toast({ variant: 'destructive', title: 'Media Access Error', description, duration: 7000 });
        onEndCall();
      }
    };

    initialize();

    return () => {
      console.log("Running cleanup for VideoCallView useEffect for callId:", callId);
      if (callDocUnsubscribe) {
        callDocUnsubscribe();
      }
      iceCandidateListenersUnsubscribeRef.current.forEach(unsubscribe => unsubscribe());
      iceCandidateListenersUnsubscribeRef.current = [];
      
      // Call cleanupCall here if onEndCall wasn't triggered by user action
      // This covers cases like component unmount due to navigation
      // Check if peerConnection is still around to decide if cleanupCall is still needed
      // Note: onEndCall itself calls cleanupCall, so avoid double-calling if user explicitly ended.
      // However, if the component unmounts for other reasons, cleanup is vital.
      if (pcInstance || localStream) { // Check if resources were initialized
         // cleanupCall(); // The main onEndCall from ChatWindow should handle this.
                          // Direct call here can lead to race conditions if ChatWindow also calls it.
                          // The onEndCall prop *must* eventually lead to cleanupCall.
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, localUser, toast, onEndCall]); // isCaller is managed internally

  const handleEndCall = async () => {
    console.log("User clicked end call for callId:", callId);
     if (localUser && callId && peerConnection) { // Check peerConnection to ensure call was somewhat active
        const callDocRef = doc(firestore, 'calls', callId);
        try {
            const callDocSnap = await getDoc(callDocRef);
            if (callDocSnap.exists()) {
                if (isCaller) {
                    await updateDoc(callDocRef, { status: 'ended_by_caller', endedAt: serverTimestamp() });
                } else {
                    await updateDoc(callDocRef, { status: 'ended_by_callee', endedAt: serverTimestamp() });
                }
                 console.log("Updated call status to ended by current user for callId:", callId);
            }
        } catch (error) {
            console.error("Error updating call status on end:", error);
        }
    }
    // cleanupCall(); // This is now called by onEndCall which is called below
    onEndCall(); 
  };

  const toggleMute = () => {
    setIsMuted(prev => {
      const newMutedState = !prev;
      if (localStream) {
        localStream.getAudioTracks().forEach(track => track.enabled = !newMutedState);
      }
      return newMutedState;
    });
  };

  const toggleCamera = () => {
     setIsCameraOff(prev => {
        const newCameraOffState = !prev;
        if (localStream) {
            localStream.getVideoTracks().forEach(track => track.enabled = !newCameraOffState);
        }
        return newCameraOffState;
    });
  };
  
  if (hasMediaPermission === null && isConnecting) {
    return (
      <div className="flex flex-col h-full p-4 bg-card items-center justify-center">
        <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
        <p className="text-muted-foreground">Requesting media permissions & initializing call...</p>
      </div>
    );
  }
  
  return (
    <div className="flex flex-col h-full p-4 bg-card items-center justify-center relative">
      {hasMediaPermission === false && (
        <Alert variant="destructive" className="mb-4 absolute top-4 left-1/2 -translate-x-1/2 z-10 max-w-lg w-full">
          <AlertTitle>Media Access Required</AlertTitle>
          <AlertDescription>
            Video calling requires camera and microphone access. 
            Please enable permissions in your browser settings and refresh the page, or try starting the call again.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 w-full h-full flex-1">
        <div className="md:col-span-4 bg-muted rounded-lg overflow-hidden flex items-center justify-center relative aspect-video md:aspect-auto">
          <video 
            ref={remoteVideoRef} 
            className="w-full h-full object-cover" 
            autoPlay 
            playsInline
            style={{ display: remoteStream && hasMediaPermission ? 'block' : 'none' }}
          />
          {(!remoteStream || !hasMediaPermission) && (
            <div className="flex flex-col items-center text-muted-foreground p-4 text-center">
              {isConnecting && hasMediaPermission && localUser ? (
                <>
                  <Loader2 className="h-12 w-12 animate-spin mb-2" />
                  <p> {isCaller ? "Calling..." : "Joining call..."} (Call ID: {callId})</p>
                  <p className="text-xs mt-1">Waiting for other user to connect.</p>
                </>
              ) : hasMediaPermission === false ? (
                 <>
                  <VideoOff className="h-16 w-16 mb-2 opacity-50" />
                  <p>Media permissions denied.</p>
                  <p className="text-xs mt-1">Enable camera/mic and restart call.</p>
                </>
              ) : (
                <>
                  <VideoOff className="h-16 w-16 mb-2 opacity-50" />
                   <p>{localUser && hasMediaPermission ? "Waiting for remote video..." : "Remote video unavailable"}</p>
                   <p className="text-xs mt-1">{!localUser ? "Login required." : ""}</p>
                </>
              )}
            </div>
          )}
          <p className="absolute bottom-4 left-4 bg-black/50 text-white px-2 py-1 rounded text-sm">Remote User</p>
        </div>

        <div className="md:col-span-1 flex flex-col gap-4">
            <div className="bg-muted rounded-lg overflow-hidden aspect-video relative flex-shrink-0">
              <video 
                ref={localVideoRef} 
                className="w-full h-full object-cover" 
                autoPlay 
                muted 
                playsInline 
                style={{ display: localStream && !isCameraOff && hasMediaPermission ? 'block' : 'none' }}
              />
              {(!localStream || isCameraOff || !hasMediaPermission) && (
                 <div className="w-full h-full bg-muted flex items-center justify-center">
                    {isCameraOff && localStream && hasMediaPermission ? <VideoOff className="h-12 w-12 text-foreground/50" /> 
                    : !hasMediaPermission && localStream === null ? <UserIcon className="h-12 w-12 text-foreground/50" /> // Show user icon if no permission from start
                    : <UserIcon className="h-12 w-12 text-foreground/50" /> } 
                 </div>
              )}
              <p className="absolute bottom-2 left-2 bg-black/50 text-white px-1.5 py-0.5 rounded text-xs">
                You {isMuted && "(Muted)"} {isCameraOff && "(Cam Off)"}
              </p>
            </div>
            <div className="hidden md:block p-2 bg-muted/50 rounded-lg text-center text-xs text-foreground/70 overflow-auto">
              <p className="font-semibold mb-1">Call ID: {callId.substring(0,20)}...</p>
              <p>Signaling via Firestore.</p>
            </div>
        </div>
      </div>

      <Card className="absolute bottom-4 left-1/2 transform -translate-x-1/2 shadow-xl bg-card/80 backdrop-blur-sm">
        <CardContent className="p-3 flex items-center gap-3">
          <Button 
            variant={isMuted ? "destructive" : "secondary"} 
            size="icon" 
            onClick={toggleMute} 
            aria-label={isMuted ? "Unmute" : "Mute"}
            disabled={!localStream || hasMediaPermission === false}
          >
            {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </Button>
          <Button 
            variant={isCameraOff ? "destructive" : "secondary"} 
            size="icon" 
            onClick={toggleCamera} 
            aria-label={isCameraOff ? "Turn camera on" : "Turn camera off"}
            disabled={!localStream || hasMediaPermission === false}
          >
            {isCameraOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
          </Button>
          <Button variant="destructive" size="icon" onClick={handleEndCall} aria-label="End call">
            <PhoneOff className="h-5 w-5" />
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// Fallback User icon if lucide-react doesn't have a simple one, or for styling
// const User = (props: React.SVGProps<SVGSVGElement>) => ( // Using Lucide's UserIcon instead
//   <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
//     <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
//   </svg>
// );
