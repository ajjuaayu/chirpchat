
"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Mic, MicOff, PhoneOff, Video, VideoOff, Loader2, User as UserIcon } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { User as AuthUser } from "@/types";
import { doc, onSnapshot, setDoc, updateDoc, collection, addDoc, getDoc, deleteDoc, serverTimestamp, query, getDocs, writeBatch, Timestamp } from "firebase/firestore";
import { firestore } from "@/lib/firebase";

interface VideoCallViewProps {
  callId: string;
  onEndCall: () => void;
  localUser: AuthUser; // Made non-null as ChatWindow checks for currentUser
}

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
  const [hasMediaPermission, setHasMediaPermission] = useState<boolean | null>(null); // null: checking, true: granted, false: denied
  const [isConnecting, setIsConnecting] = useState(true); // True while establishing connection
  const [isCaller, setIsCaller] = useState<boolean | null>(null);
  const [callEndedByRemote, setCallEndedByRemote] = useState(false);


  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const iceCandidateListenersUnsubscribeRef = useRef<(() => void)[]>([]);
  const callDocUnsubscribeRef = useRef<(() => void) | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null); // To access PC in cleanup

  const cleanupCall = useCallback(async (isLocalInitiated = false) => {
    console.log("Cleaning up call resources for callId:", callId, "Local initiated:", isLocalInitiated);
    
    iceCandidateListenersUnsubscribeRef.current.forEach(unsubscribe => unsubscribe());
    iceCandidateListenersUnsubscribeRef.current = [];
    
    if (callDocUnsubscribeRef.current) {
      callDocUnsubscribeRef.current();
      callDocUnsubscribeRef.current = null;
    }

    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }
    
    const pc = peerConnectionRef.current; // Use ref for current PC instance
    if (pc) {
      pc.close();
      peerConnectionRef.current = null; // Clear the ref
      setPeerConnection(null); // Clear state
    }
    setRemoteStream(null);

    // Firestore cleanup only if this user is the caller OR no callee ever joined
    // This allows the call document to be reused if a fixed callId is used.
    if (callId && localUser) {
      const callDocRef = doc(firestore, 'calls', callId);
      try {
        const callDocSnap = await getDoc(callDocRef);
        if (callDocSnap.exists()) {
          const callData = callDocSnap.data();
          // Caller cleans up if they initiated end, or if callee left and caller is now ending.
          // Or if no callee ever joined.
          if (isLocalInitiated && (callData.callerId === localUser.uid || !callData.calleeId)) {
            console.log("Local user (caller or sole participant) is ending. Deleting call document and subcollections for callId:", callId);
            const batch = writeBatch(firestore);
            const callerCandidatesQuery = query(collection(firestore, `calls/${callId}/callerCandidates`));
            const callerCandidatesSnap = await getDocs(callerCandidatesQuery);
            callerCandidatesSnap.forEach(doc => batch.delete(doc.ref));
            
            const calleeCandidatesQuery = query(collection(firestore, `calls/${callId}/calleeCandidates`));
            const calleeCandidatesSnap = await getDocs(calleeCandidatesQuery);
            calleeCandidatesSnap.forEach(doc => batch.delete(doc.ref));
            
            batch.delete(callDocRef);
            await batch.commit();
            console.log("Call document and subcollections deleted by local user.");
          } else if (isLocalInitiated && callData.calleeId === localUser.uid) {
             // Callee is leaving, update status
            await updateDoc(callDocRef, { 
              status: 'ended_by_callee', 
              [`callee_${localUser.uid}_leftAt`]: serverTimestamp(),
              calleeId: null // Marking callee as left, allows another to potentially join if caller stays.
            });
            console.log("Callee left call, updated status for callId:", callId);
          }
          // If !isLocalInitiated, it means remote ended, doc might already be deleted or status updated.
        }
      } catch (error) {
        console.error("Error cleaning up call document:", error);
      }
    }
  }, [callId, localUser, localStream]); // Removed peerConnection from deps, using ref instead

  // Initialize Peer Connection and Media
  useEffect(() => {
    let pcInstance: RTCPeerConnection; // Keep instance locally in effect scope

    const initialize = async () => {
      setIsConnecting(true);
      setCallEndedByRemote(false);

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        setLocalStream(stream);
        setHasMediaPermission(true);
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        pcInstance = new RTCPeerConnection(stunServers);
        peerConnectionRef.current = pcInstance; // Store in ref
        setPeerConnection(pcInstance); // And state

        stream.getTracks().forEach(track => pcInstance.addTrack(track, stream));

        pcInstance.onicecandidate = event => {
          if (event.candidate && callId && isCaller !== null) { // Check isCaller to determine collection
            const candidatesCollectionPath = isCaller ? `calls/${callId}/callerCandidates` : `calls/${callId}/calleeCandidates`;
            addDoc(collection(firestore, candidatesCollectionPath), event.candidate.toJSON())
              .catch(e => console.error("Error adding ICE candidate to Firestore:", e));
          }
        };

        pcInstance.ontrack = event => {
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
            // Consider if call should auto-end. 'closed' definitely means end.
            // 'failed' might be recoverable with ICE restart, but for simplicity, treat as end.
             if (pcInstance?.connectionState === 'closed' || pcInstance?.connectionState === 'failed') {
                if (!callEndedByRemote) { // Avoid double-trigger if remote already signaled end
                    console.log("Peer connection closed or failed, ending call.");
                    // onEndCall(); // Let Firestore 'ended' status or doc deletion trigger this.
                }
             }
            setIsConnecting(false);
          }
        };

        // Signaling logic
        const callDocRef = doc(firestore, 'calls', callId);
        const callDocSnap = await getDoc(callDocRef);
        let currentIsCaller = false;

        if (!callDocSnap.exists() || (callDocSnap.exists() && callDocSnap.data().status && ['ended', 'ended_by_caller', 'ended_by_callee'].includes(callDocSnap.data().status))) {
          // If doc doesn't exist, or exists but was an ended call, this user is the new caller.
          // This allows reusing a fixed callId after cleanup.
          if(callDocSnap.exists()){ // if it's an old ended call, delete it first to start fresh
            await deleteDoc(callDocRef); // Simpler than trying to overwrite all fields
          }

          currentIsCaller = true;
          setIsCaller(true);
          const offerDescription = await pcInstance.createOffer();
          await pcInstance.setLocalDescription(offerDescription);

          const callData = {
            callerId: localUser.uid,
            callerName: localUser.displayName || "Anonymous Caller",
            offer: { type: offerDescription.type, sdp: offerDescription.sdp },
            status: 'ringing',
            createdAt: serverTimestamp(),
            calleeId: null,
          };
          await setDoc(callDocRef, callData);
          console.log("Caller: Created offer and call document", callId);
        } else { // Document exists and is potentially active or ringing for someone else
          currentIsCaller = false;
          setIsCaller(false);
          const callData = callDocSnap.data();

          if (callData.callerId === localUser.uid) {
            // This user is the original caller, perhaps rejoining (e.g. after refresh)
            console.log("Caller re-joined their own call window for callId:", callId);
            currentIsCaller = true; // Corrected
            setIsCaller(true);
            if (callData.offer && pcInstance.signalingState === 'new') { // Ensure local desc is set if needed
                await pcInstance.setLocalDescription(new RTCSessionDescription(callData.offer));
            }
            if (callData.answer && pcInstance.signalingState !== 'stable') {
              await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.answer));
              setIsConnecting(false);
            }
          } else if (callData.status === 'ringing' && !callData.calleeId) {
            // Call is ringing, no callee yet. This user joins as callee.
            await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.offer));
            const answerDescription = await pcInstance.createAnswer();
            await pcInstance.setLocalDescription(answerDescription);

            await updateDoc(callDocRef, {
              calleeId: localUser.uid,
              calleeName: localUser.displayName || "Anonymous Callee",
              answer: { type: answerDescription.type, sdp: answerDescription.sdp },
              status: 'active',
              joinedAt: serverTimestamp(),
            });
            console.log("Callee: Joined call, created answer for callId:", callId);
            setIsConnecting(false);
          } else if (callData.status === 'active' && callData.calleeId && callData.calleeId !== localUser.uid) {
             // Call is active but with another callee.
            console.warn("Call is busy with another participant for callId:", callId);
            toast({variant: "destructive", title: "Call Busy", description: "This call is already in progress with another participant."});
            onEndCall(); // This will trigger cleanup for this user.
            return;
          } else if (callData.status === 'active' && callData.calleeId === localUser.uid) {
            // This user is the callee, rejoining an active call.
            console.log("Callee re-joined an active call for callId:", callId);
            if (callData.offer && callData.answer && pcInstance.signalingState !== 'stable') {
                await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.offer));
                await pcInstance.setLocalDescription(new RTCSessionDescription(callData.answer));
            }
            setIsConnecting(false);
          } else {
            console.warn("Call document exists but state is unexpected or not joinable for callId:", callId, callData);
            toast({variant: "destructive", title: "Call Error", description: "Call is in an invalid state or cannot be joined."});
            onEndCall();
            return;
          }
        }

        // Listen for ICE candidates from the other party
        const remoteCandidatesCollectionPath = currentIsCaller ? `calls/${callId}/calleeCandidates` : `calls/${callId}/callerCandidates`;
        const unsubRemoteCandidates = onSnapshot(collection(firestore, remoteCandidatesCollectionPath), snapshot => {
          snapshot.docChanges().forEach(change => {
            if (change.type === 'added') {
              pcInstance?.addIceCandidate(new RTCIceCandidate(change.doc.data()))
                .catch(e => console.error("Error adding remote ICE candidate:", e));
            }
          });
        });
        iceCandidateListenersUnsubscribeRef.current.push(unsubRemoteCandidates);
        
        // Listen for changes to the call document (e.g., answer from callee, or call ended by other party)
        callDocUnsubscribeRef.current = onSnapshot(callDocRef, async (snapshot) => {
          const data = snapshot.data();
          if (!snapshot.exists()) { // Document deleted
            console.log("Call document deleted, call ended by other party or cleanup for callId:", callId);
            setCallEndedByRemote(true);
            if (peerConnectionRef.current && peerConnectionRef.current.connectionState !== 'closed') {
                toast({title: "Call Ended", description: "The call has concluded."});
            }
            onEndCall(); // Ensure local cleanup and UI update
            return;
          }

          // Caller logic: if an answer appears from callee
          if (currentIsCaller && data.answer && pcInstance?.signalingState !== 'stable' && pcInstance.remoteDescription === null) {
            try {
                await pcInstance.setRemoteDescription(new RTCSessionDescription(data.answer));
                console.log("Caller: Set remote answer from Firestore for callId:", callId);
                setIsConnecting(false); // Connection should be establishing now
            } catch (e) {
                console.error("Caller: Error setting remote answer:", e);
            }
          }

          // If call status indicates ended by the other party
          if (data.status && ['ended', 'ended_by_caller', 'ended_by_callee'].includes(data.status)) {
            const remotelyEnded = (currentIsCaller && data.status === 'ended_by_callee') || 
                                  (!currentIsCaller && data.status === 'ended_by_caller') ||
                                  data.status === 'ended';
            if (remotelyEnded) {
                console.log("Call ended by other party or explicitly for callId:", callId);
                setCallEndedByRemote(true);
                if (peerConnectionRef.current && peerConnectionRef.current.connectionState !== 'closed') {
                     toast({title: "Call Ended", description: "The other user has ended the call."});
                }
                onEndCall(); // Triggers local cleanup and UI update
            }
          }
        });

      } catch (error) {
        console.error('Error initializing video call:', error);
        setHasMediaPermission(false); // Explicitly set based on error
        let description = 'Please enable camera and microphone permissions in your browser settings.';
        if (error instanceof Error) {
          if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            description = 'Camera and microphone access was denied. Please enable it in your browser settings and refresh.';
          } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
            description = 'No camera or microphone found. Please ensure they are connected and enabled.';
          }
        }
        toast({ variant: 'destructive', title: 'Media Access Error', description, duration: 7000 });
        onEndCall(); // Ensure cleanup and UI update
      }
    };

    initialize();

    return () => {
      console.log("VideoCallView useEffect cleanup triggered for callId:", callId);
      cleanupCall(false); // Pass false as it's unmount, not necessarily user-initiated end action here
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, localUser.uid]); // Only re-run if callId or user changes. LocalUser object might change more often.

  const handleLocalEndCall = async () => {
    console.log("User clicked end call button for callId:", callId);
    setCallEndedByRemote(false); // Reset this as local user is ending

    if (callId && localUser && peerConnectionRef.current) {
        const callDocRef = doc(firestore, 'calls', callId);
        try {
            const callDocSnap = await getDoc(callDocRef);
            if (callDocSnap.exists()) {
                // Caller deleting the doc is handled in cleanupCall if they are the one ending.
                // Callee updates status.
                if (isCaller) {
                     // Caller ending will lead to document deletion in cleanupCall
                     await updateDoc(callDocRef, { status: 'ended_by_caller', endedAt: serverTimestamp() });
                } else {
                    await updateDoc(callDocRef, { 
                        status: 'ended_by_callee', 
                        calleeId: null, // Make slot available if caller stays
                        endedAt: serverTimestamp() 
                    });
                }
                console.log("Updated call status to ended by current user for callId:", callId);
            }
        } catch (error) {
            console.error("Error updating call status on end:", error);
        }
    }
    await cleanupCall(true); // Indicate local user initiated this end
    onEndCall(); // Propagate to parent to update UI
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
  
  // Initial loading state for permissions
  if (hasMediaPermission === null) {
    return (
      <div className="flex flex-col h-full p-4 bg-card items-center justify-center">
        <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
        <p className="text-muted-foreground">Requesting media permissions...</p>
      </div>
    );
  }
  
  return (
    <div className="flex flex-col h-full p-4 bg-card items-center justify-center relative">
      {hasMediaPermission === false && ( // Show if permissions were explicitly denied
        <Alert variant="destructive" className="mb-4 absolute top-4 left-1/2 -translate-x-1/2 z-10 max-w-lg w-full">
          <AlertTitle>Media Access Required</AlertTitle>
          <AlertDescription>
            Video calling requires camera and microphone access. 
            Please enable permissions in your browser settings and try starting the call again.
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
          {(!remoteStream && hasMediaPermission) && ( // Only show placeholder if permissions are granted but no remote stream
            <div className="flex flex-col items-center text-muted-foreground p-4 text-center">
              {isConnecting ? (
                <>
                  <Loader2 className="h-12 w-12 animate-spin mb-2" />
                  <p> {isCaller ? "Calling..." : "Attempting to join..."} </p>
                  <p className="text-xs mt-1">Waiting for other user to connect.</p>
                </>
              ) : (
                <>
                  <VideoOff className="h-16 w-16 mb-2 opacity-50" />
                   <p>Waiting for remote video...</p>
                </>
              )}
            </div>
          )}
          {hasMediaPermission && <p className="absolute bottom-4 left-4 bg-black/50 text-white px-2 py-1 rounded text-sm">Remote User</p>}
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
              {(!localStream || isCameraOff || !hasMediaPermission ) && ( // Show icon if no stream, camera off, or no permission
                 <div className="w-full h-full bg-muted flex items-center justify-center">
                    {isCameraOff && localStream && hasMediaPermission ? <VideoOff className="h-12 w-12 text-foreground/50" /> 
                    : <UserIcon className="h-12 w-12 text-foreground/50" /> } 
                 </div>
              )}
             {hasMediaPermission &&  <p className="absolute bottom-2 left-2 bg-black/50 text-white px-1.5 py-0.5 rounded text-xs">
                You {isMuted && "(Muted)"} {isCameraOff && "(Cam Off)"}
              </p>}
            </div>
            <div className="hidden md:block p-2 bg-muted/50 rounded-lg text-center text-xs text-foreground/70 overflow-auto">
              <p className="font-semibold mb-1 truncate">Call ID: {callId}</p>
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
          <Button variant="destructive" size="icon" onClick={handleLocalEndCall} aria-label="End call" disabled={hasMediaPermission === false}>
            <PhoneOff className="h-5 w-5" />
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
