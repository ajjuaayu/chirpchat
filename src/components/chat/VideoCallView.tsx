
"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Mic, MicOff, PhoneOff, Video, VideoOff, Loader2, User as UserIcon, AlertTriangle } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { User as AuthUser } from "@/types";
import { doc, onSnapshot, setDoc, updateDoc, collection, addDoc, getDoc, deleteDoc, serverTimestamp, query, getDocs, writeBatch, Timestamp, Unsubscribe } from "firebase/firestore";
import { firestore } from "@/lib/firebase";

interface VideoCallViewProps {
  callId: string;
  onEndCall: () => void;
  localUser: AuthUser;
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
  const [hasMediaPermission, setHasMediaPermission] = useState<boolean | null>(null);
  const [isConnecting, setIsConnecting] = useState(true);
  const [isCaller, setIsCaller] = useState<boolean | null>(null);
  const [callEndedByRemote, setCallEndedByRemote] = useState(false);


  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  
  const iceCandidateListenersUnsubscribeRef = useRef<Unsubscribe[]>([]);
  const callDocUnsubscribeRef = useRef<Unsubscribe | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null); // Use ref for direct access to PC instance

  const cleanupCall = useCallback(async (isLocalInitiated = false) => {
    console.log("VideoCallView: cleanupCall triggered. callId:", callId, "Local initiated:", isLocalInitiated);
    
    iceCandidateListenersUnsubscribeRef.current.forEach(unsubscribe => unsubscribe());
    iceCandidateListenersUnsubscribeRef.current = [];
    
    if (callDocUnsubscribeRef.current) {
      callDocUnsubscribeRef.current();
      callDocUnsubscribeRef.current = null;
    }

    if (localStream) {
      console.log("VideoCallView: Stopping local stream tracks.");
      localStream.getTracks().forEach(track => track.stop());
      if (localVideoRef.current) {
          localVideoRef.current.srcObject = null; 
      }
      setLocalStream(null); // Clear state
    }
    
    const pc = peerConnectionRef.current;
    if (pc) {
      console.log("VideoCallView: Closing peer connection.");
      pc.close();
      peerConnectionRef.current = null;
      setPeerConnection(null); // Clear state
    }
    setRemoteStream(null); // Clear state

    if (callId && localUser) {
      const callDocRef = doc(firestore, 'calls', callId);
      try {
        const callDocSnap = await getDoc(callDocRef);
        if (callDocSnap.exists()) {
          const callData = callDocSnap.data();
          // Only the caller or the last participant should delete the document
          if (isLocalInitiated && (callData.callerId === localUser.uid || (callData.callerId && !callData.calleeId))) {
            console.log("VideoCallView: Caller or sole participant is ending. Deleting call document and subcollections for callId:", callId);
            const batch = writeBatch(firestore);
            const callerCandidatesQuery = query(collection(firestore, `calls/${callId}/callerCandidates`));
            const callerCandidatesSnap = await getDocs(callerCandidatesQuery);
            callerCandidatesSnap.forEach(doc => batch.delete(doc.ref));
            console.log(`VideoCallView: Deleting ${callerCandidatesSnap.size} caller candidates.`);
            
            const calleeCandidatesQuery = query(collection(firestore, `calls/${callId}/calleeCandidates`));
            const calleeCandidatesSnap = await getDocs(calleeCandidatesQuery);
            calleeCandidatesSnap.forEach(doc => batch.delete(doc.ref));
            console.log(`VideoCallView: Deleting ${calleeCandidatesSnap.size} callee candidates.`);
            
            batch.delete(callDocRef);
            await batch.commit();
            console.log("VideoCallView: Call document and subcollections deleted by local user (caller/sole participant).");
          } else if (isLocalInitiated && callData.calleeId === localUser.uid) {
            // Callee is leaving, update status, don't delete if caller might still be there
            console.log("VideoCallView: Callee left call, updating status for callId:", callId);
            await updateDoc(callDocRef, { 
              status: 'ended_by_callee', 
              [`callee_${localUser.uid}_leftAt`]: serverTimestamp(),
              calleeId: null // Make the call available again or indicate callee left
            });
          }
        }
      } catch (error) {
        console.error("VideoCallView: Error cleaning up call document:", error);
      }
    }
  }, [callId, localUser, localStream]); // localStream added to dependencies

  useEffect(() => {
    console.log("VideoCallView: useEffect for call initialization triggered. callId:", callId, "Local user UID:", localUser?.uid);
    let pcInstance: RTCPeerConnection;
    let mediaAcquiredSuccessfully = false;

    const initialize = async () => {
      console.log("VideoCallView: initialize() started.");
      setIsConnecting(true);
      setCallEndedByRemote(false);

      try {
        console.log("VideoCallView: Requesting media devices...");
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        console.log("VideoCallView: Media devices acquired successfully.");
        setLocalStream(stream);
        setHasMediaPermission(true);
        mediaAcquiredSuccessfully = true;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        console.log("VideoCallView: Creating RTCPeerConnection with STUN servers:", stunServers);
        pcInstance = new RTCPeerConnection(stunServers);
        peerConnectionRef.current = pcInstance; // Store in ref
        setPeerConnection(pcInstance); // Update state
        console.log("VideoCallView: RTCPeerConnection created:", pcInstance);


        console.log("VideoCallView: Adding local stream tracks to peer connection.");
        stream.getTracks().forEach(track => pcInstance.addTrack(track, stream));

        pcInstance.onicecandidate = event => {
          console.log("VideoCallView: onicecandidate event:", event?.candidate ? event.candidate : "No candidate");
          if (event.candidate && callId && isCaller !== null) { // isCaller must be set
            const candidatesCollectionPath = isCaller ? `calls/${callId}/callerCandidates` : `calls/${callId}/calleeCandidates`;
            console.log(`VideoCallView: Adding ICE candidate to Firestore: ${candidatesCollectionPath}`, event.candidate.toJSON());
            addDoc(collection(firestore, candidatesCollectionPath), event.candidate.toJSON())
              .catch(e => console.error("VideoCallView: Error adding ICE candidate to Firestore:", e));
          }
        };

        pcInstance.ontrack = event => {
          console.log("VideoCallView: ontrack event. Streams:", event.streams);
          if (event.streams && event.streams[0]) {
            console.log("VideoCallView: Remote stream received, setting to remoteVideoRef.");
            setRemoteStream(event.streams[0]);
            if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = event.streams[0];
            }
             // If we get tracks, we are likely connected or very close
          } else {
            console.log("VideoCallView: ontrack event but no stream[0].");
          }
        };
        
        pcInstance.onconnectionstatechange = () => {
          console.log("VideoCallView: Peer connection state changed to:", pcInstance?.connectionState);
          if (pcInstance?.connectionState === 'connected') {
            console.log("VideoCallView: Peer connection state is 'connected'.");
            setIsConnecting(false);
          } else if (['disconnected', 'failed', 'closed'].includes(pcInstance?.connectionState || '')) {
             console.warn("VideoCallView: Peer connection state is disconnected, failed, or closed:", pcInstance?.connectionState);
             if (!callEndedByRemote && (pcInstance?.connectionState === 'closed' || pcInstance?.connectionState === 'failed')) {
                console.log("VideoCallView: Peer connection closed or failed definitively, triggering onEndCall.");
                // onEndCall(); // This might be too aggressive, callDocUnsubscribe handles remote ends
             }
            setIsConnecting(false); // No longer actively trying to connect if failed/closed
          }
        };

        const callDocRef = doc(firestore, 'calls', callId);
        console.log("VideoCallView: Checking Firestore for call document:", callDocRef.path);
        const callDocSnap = await getDoc(callDocRef);
        let currentIsCaller = false; // Temporary variable to set isCaller state reliably

        if (!callDocSnap.exists() || (callDocSnap.exists() && callDocSnap.data().status && ['ended', 'ended_by_caller', 'ended_by_callee'].includes(callDocSnap.data().status))) {
          if(callDocSnap.exists()){
            console.log("VideoCallView: Existing call document found but status is ended. Will attempt to delete and recreate as caller.", callDocSnap.data());
            // Potentially delete old call artifacts before creating a new one.
            // This is important for fixed call IDs to allow re-initiation.
            await deleteDoc(callDocRef).catch(e => console.warn("VideoCallView: Could not delete old ended call doc, might be permissions or already deleted", e));
            // Also clear out old candidates
            const oldCallerCandidates = await getDocs(query(collection(firestore, `calls/${callId}/callerCandidates`)));
            oldCallerCandidates.forEach(async (d) => await deleteDoc(d.ref));
            const oldCalleeCandidates = await getDocs(query(collection(firestore, `calls/${callId}/calleeCandidates`)));
            oldCalleeCandidates.forEach(async (d) => await deleteDoc(d.ref));
            console.log("VideoCallView: Deleted stale call document and candidates for fixed call ID:", callId);

          } else {
            console.log("VideoCallView: No existing call document found. Current user will be the caller.");
          }
          
          currentIsCaller = true;
          setIsCaller(true);
          console.log("VideoCallView: Current user is Caller. Creating offer. Signaling state:", pcInstance.signalingState);
          const offerDescription = await pcInstance.createOffer();
          console.log("VideoCallView: Offer created. Signaling state:", pcInstance.signalingState);
          try {
            await pcInstance.setLocalDescription(offerDescription);
            console.log("VideoCallView: Local description (offer) set. Signaling state:", pcInstance.signalingState);
          } catch (e) {
            console.error("VideoCallView: Error setting local description (offer):", e, "Signaling state:", pcInstance.signalingState);
            throw e; // Re-throw to be caught by outer try-catch
          }

          const callData = {
            callerId: localUser.uid,
            callerName: localUser.displayName || "Anonymous Caller",
            offer: { type: offerDescription.type, sdp: offerDescription.sdp },
            status: 'ringing',
            createdAt: serverTimestamp(),
            calleeId: null, // Explicitly null
          };
          console.log("VideoCallView: Setting call document in Firestore with offer:", callData);
          await setDoc(callDocRef, callData);
          console.log("VideoCallView: Caller: Call document created with offer.");
        } else {
          // Call document exists and is not 'ended'
          const callData = callDocSnap.data();
          console.log("VideoCallView: Existing call document found:", callData);

          if (callData.callerId === localUser.uid) {
            // This user is the original caller, potentially rejoining or reconnecting
            console.log("VideoCallView: Current user is the original Caller, attempting to re-establish connection. Signaling state:", pcInstance.signalingState);
            currentIsCaller = true;
            setIsCaller(true);
             // If offer exists and localDesc isn't set, set it.
            if (callData.offer && !pcInstance.currentLocalDescription) {
              console.log("VideoCallView: Caller rejoining, setting local description from stored offer. Signaling state:", pcInstance.signalingState);
              try {
                await pcInstance.setLocalDescription(new RTCSessionDescription(callData.offer));
                console.log("VideoCallView: Caller rejoining, local description set. Signaling state:", pcInstance.signalingState);
              } catch (e) {
                console.error("VideoCallView: Error setting local description for rejoining caller:", e, "Signaling state:", pcInstance.signalingState);
              }
            }
            // If answer exists and remoteDesc isn't set, set it.
            if (callData.answer && !pcInstance.currentRemoteDescription) {
              console.log("VideoCallView: Caller rejoining, setting remote description from stored answer. Signaling state:", pcInstance.signalingState);
              try {
                await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.answer));
                console.log("VideoCallView: Caller rejoining, remote description set. Signaling state:", pcInstance.signalingState);
              } catch (e) {
                console.error("VideoCallView: Error setting remote description for rejoining caller:", e, "Signaling state:", pcInstance.signalingState);
              }
            }
            if(pcInstance.remoteDescription && pcInstance.localDescription) setIsConnecting(false);


          } else if (callData.status === 'ringing' && !callData.calleeId) {
            // This user is a Callee joining a ringing call
            console.log("VideoCallView: Current user is Callee, joining ringing call. Signaling state:", pcInstance.signalingState);
            currentIsCaller = false;
            setIsCaller(false);
            
            console.log("VideoCallView: Callee: Setting remote description (offer). Signaling state:", pcInstance.signalingState);
            try {
              await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.offer));
              console.log("VideoCallView: Callee: Remote description (offer) set. Signaling state:", pcInstance.signalingState);
            } catch (e) {
              console.error("VideoCallView: Error setting remote description (offer) for callee:", e, "Signaling state:", pcInstance.signalingState);
              throw e;
            }
            
            console.log("VideoCallView: Callee: Creating answer. Signaling state:", pcInstance.signalingState);
            const answerDescription = await pcInstance.createAnswer();
            console.log("VideoCallView: Callee: Answer created. Signaling state:", pcInstance.signalingState);
            try {
              await pcInstance.setLocalDescription(answerDescription);
              console.log("VideoCallView: Callee: Local description (answer) set. Signaling state:", pcInstance.signalingState);
            } catch (e) {
              console.error("VideoCallView: Error setting local description (answer) for callee:", e, "Signaling state:", pcInstance.signalingState);
              throw e;
            }

            const calleeUpdateData = {
              calleeId: localUser.uid,
              calleeName: localUser.displayName || "Anonymous Callee",
              answer: { type: answerDescription.type, sdp: answerDescription.sdp },
              status: 'active',
              joinedAt: serverTimestamp(),
            };
            console.log("VideoCallView: Callee: Updating call document in Firestore with answer:", calleeUpdateData);
            await updateDoc(callDocRef, calleeUpdateData);
            console.log("VideoCallView: Callee: Call document updated with answer.");
            setIsConnecting(false);
          } else if (callData.status === 'active' && callData.calleeId && callData.calleeId !== localUser.uid && callData.callerId !== localUser.uid) {
            // Call is active but with someone else
            console.warn("VideoCallView: Call is busy with another participant. Current User:", localUser.uid, "Caller:", callData.callerId, "Callee:", callData.calleeId);
            toast({variant: "destructive", title: "Call Busy", description: "This call is already in progress with another participant."});
            onEndCall(); // Trigger cleanup and exit
            return; // Stop further execution for this user
          } else if (callData.status === 'active' && callData.calleeId === localUser.uid) {
            // Callee rejoining an active call
            console.log("VideoCallView: Current user is Callee, rejoining active call. Signaling state:", pcInstance.signalingState);
            currentIsCaller = false;
            setIsCaller(false);
            if (callData.offer && !pcInstance.currentRemoteDescription) {
                 console.log("VideoCallView: Callee rejoining, setting remote description from stored offer. Signaling state:", pcInstance.signalingState);
                 try {
                    await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.offer));
                    console.log("VideoCallView: Callee rejoining, remote description set. Signaling state:", pcInstance.signalingState);
                 } catch (e) {
                    console.error("VideoCallView: Error setting remote description for rejoining callee:", e, "Signaling state:", pcInstance.signalingState);
                 }
            }
            if (callData.answer && !pcInstance.currentLocalDescription) {
                console.log("VideoCallView: Callee rejoining, setting local description from stored answer. Signaling state:", pcInstance.signalingState);
                try {
                    await pcInstance.setLocalDescription(new RTCSessionDescription(callData.answer));
                    console.log("VideoCallView: Callee rejoining, local description set. Signaling state:", pcInstance.signalingState);
                } catch (e) {
                    console.error("VideoCallView: Error setting local description for rejoining callee:", e, "Signaling state:", pcInstance.signalingState);
                }
            }
            if(pcInstance.remoteDescription && pcInstance.localDescription) setIsConnecting(false);
          } else {
            console.warn("VideoCallView: Call document exists but state is unexpected or not joinable. Data:", callData, "Local User:", localUser.uid);
            toast({variant: "destructive", title: "Call Error", description: "Call is in an invalid state or cannot be joined."});
            onEndCall(); // Trigger cleanup and exit
            return; // Stop further execution
          }
        }

        // Setup ICE candidate listeners for the other party
        // Ensure `currentIsCaller` is correctly set before this point. `isCaller` (state) might not update immediately.
        const remoteCandidatesCollectionPath = currentIsCaller ? `calls/${callId}/calleeCandidates` : `calls/${callId}/callerCandidates`;
        console.log("VideoCallView: Setting up listener for remote ICE candidates at:", remoteCandidatesCollectionPath);
        const unsubRemoteCandidates = onSnapshot(collection(firestore, remoteCandidatesCollectionPath), snapshot => {
          snapshot.docChanges().forEach(async change => { // Mark as async for await
            if (change.type === 'added') {
              console.log("VideoCallView: Received remote ICE candidate:", change.doc.data());
              try {
                if (pcInstance && pcInstance.signalingState !== 'closed') { // Check if pcInstance is still valid
                  await pcInstance.addIceCandidate(new RTCIceCandidate(change.doc.data()));
                  console.log("VideoCallView: Remote ICE candidate added successfully.");
                } else {
                  console.warn("VideoCallView: PeerConnection closed or null, cannot add ICE candidate.");
                }
              } catch (e) {
                console.error("VideoCallView: Error adding remote ICE candidate:", e, "Signaling state:", pcInstance?.signalingState);
              }
            }
          });
        });
        iceCandidateListenersUnsubscribeRef.current.push(unsubRemoteCandidates);
        
        // Listener for the main call document for offer/answer and status changes
        console.log("VideoCallView: Setting up listener for call document changes at:", callDocRef.path);
        callDocUnsubscribeRef.current = onSnapshot(callDocRef, async (snapshot) => { // Mark as async for await
          const data = snapshot.data();
          console.log("VideoCallView: Call document snapshot received. Exists:", snapshot.exists(), "Data:", data);

          if (!snapshot.exists()) {
            console.log("VideoCallView: Call document deleted, signaling call end.");
            if (!callEndedByRemote && peerConnectionRef.current?.connectionState !== 'closed') {
                // Avoid toast if local user initiated the end that led to deletion.
                // This check is heuristic, better would be explicit state.
                const pc = peerConnectionRef.current;
                if (!(isCaller === true && pc?.signalingState === 'closed' && pc?.iceConnectionState === 'closed') && // Caller fully closed
                    !(isCaller === false && pc?.signalingState === 'closed' && pc?.iceConnectionState === 'closed')) { // Callee fully closed
                    toast({title: "Call Ended", description: "The call has concluded."});
                }
            }
            setCallEndedByRemote(true); // Assume remote end if doc disappears without local action
            onEndCall();
            return;
          }

          // Caller: if an answer appears, set it as remote description
          if (currentIsCaller && data?.answer && pcInstance?.signalingState !== 'stable' && !pcInstance?.currentRemoteDescription) {
            console.log("VideoCallView: Caller: Detected answer in call document. Signaling state:", pcInstance.signalingState);
            try {
                await pcInstance.setRemoteDescription(new RTCSessionDescription(data.answer));
                console.log("VideoCallView: Caller: Remote description (answer) set. Signaling state:", pcInstance.signalingState);
                setIsConnecting(false); // Should be connected or connecting shortly after
            } catch (e) {
                console.error("VideoCallView: Caller: Error setting remote description (answer):", e, "Signaling state:", pcInstance.signalingState);
            }
          }

          // Handle call ended by other party
          if (data?.status && ['ended', 'ended_by_caller', 'ended_by_callee'].includes(data.status)) {
            const remotelyEndedByCaller = !currentIsCaller && data.status === 'ended_by_caller';
            const remotelyEndedByCallee = currentIsCaller && data.status === 'ended_by_callee';
            const generallyEnded = data.status === 'ended';

            if (remotelyEndedByCaller || remotelyEndedByCallee || generallyEnded) {
                console.log("VideoCallView: Call ended by other party or explicitly. Status:", data.status);
                setCallEndedByRemote(true);
                if (peerConnectionRef.current && peerConnectionRef.current.connectionState !== 'closed') {
                     toast({title: "Call Ended", description: "The other user has ended the call."});
                }
                onEndCall(); // Trigger cleanup and UI update
            }
          }
        });

      } catch (error) {
        console.error('VideoCallView: Error during initialize function:', error);
        let title = 'Media Access Error';
        let description = 'Could not start video call.';

        if (mediaAcquiredSuccessfully) {
          title = 'Call Setup Error';
          description = 'Failed to set up the call. Please try again.';
        } else {
          setHasMediaPermission(false); 
          if (error instanceof Error) {
            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
              description = 'Camera and microphone access was denied. Please enable it in your browser settings and refresh.';
            } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
              description = 'No camera or microphone found. Please ensure they are connected and enabled.';
            } else {
               description = (error as Error).message || 'An unexpected error occurred while accessing media devices.';
            }
          }
        }
        toast({ variant: 'destructive', title, description, duration: 7000 });
        onEndCall(); // Ensure cleanup and UI update on error
      }
    };

    if (localUser?.uid) { // Ensure localUser is available before initializing
        initialize();
    } else {
        console.error("VideoCallView: Local user data not available, cannot initialize call.");
        toast({ variant: "destructive", title: "User Error", description: "Your user information is not available. Please try logging in again."});
        onEndCall();
    }


    // Cleanup function for useEffect
    return () => {
      console.log("VideoCallView: useEffect cleanup triggered for callId:", callId);
      cleanupCall(false); // Pass false as it's a component unmount/dependency change, not user action
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, localUser?.uid]); // localUser.uid to re-run if user changes, callId for new calls

  const handleLocalEndCall = async () => {
    console.log("VideoCallView: User clicked end call button for callId:", callId);
    setCallEndedByRemote(false); // This is a local action

    if (callId && localUser && peerConnectionRef.current) {
        const callDocRef = doc(firestore, 'calls', callId);
        try {
            const callDocSnap = await getDoc(callDocRef);
            if (callDocSnap.exists()) {
                const currentStatus = callDocSnap.data().status;
                // Avoid repeated updates if already ended
                if (currentStatus !== 'ended' && currentStatus !== 'ended_by_caller' && currentStatus !== 'ended_by_callee') {
                    if (isCaller) { // isCaller state should be reliable by now
                        await updateDoc(callDocRef, { status: 'ended_by_caller', endedAt: serverTimestamp() });
                    } else {
                        await updateDoc(callDocRef, { 
                            status: 'ended_by_callee', 
                            calleeId: null, // Make call available again or just mark as callee left
                            endedAt: serverTimestamp() 
                        });
                    }
                    console.log("VideoCallView: Updated call status to ended by current user for callId:", callId);
                }
            }
        } catch (error) {
            console.error("VideoCallView: Error updating call status on end:", error);
        }
    }
    await cleanupCall(true); // Pass true for local initiation of cleanup
    onEndCall(); // Propagate to parent
  };

  const toggleMute = () => {
    setIsMuted(prev => {
      const newMutedState = !prev;
      if (localStream) {
        localStream.getAudioTracks().forEach(track => track.enabled = !newMutedState);
        console.log("VideoCallView: Mic " + (newMutedState ? "muted" : "unmuted"));
      }
      return newMutedState;
    });
  };

  const toggleCamera = () => {
     setIsCameraOff(prev => {
        const newCameraOffState = !prev;
        if (localStream) {
            localStream.getVideoTracks().forEach(track => track.enabled = !newCameraOffState);
            console.log("VideoCallView: Camera " + (newCameraOffState ? "off" : "on"));
        }
        // Show/hide local video element based on camera state
        if (localVideoRef.current) {
            localVideoRef.current.style.display = newCameraOffState ? 'none' : 'block';
        }
        return newCameraOffState;
    });
  };
  
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
      {hasMediaPermission === false && ( // Only show if explicitly false, not null
        <Alert variant="destructive" className="mb-4 absolute top-4 left-1/2 -translate-x-1/2 z-10 max-w-lg w-full">
          <AlertTitle>Media Access Required</AlertTitle>
          <AlertDescription>
            Video calling requires camera and microphone access. 
            Please enable permissions in your browser settings and try starting the call again.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 w-full h-full flex-1">
        {/* Remote Video */}
        <div className="md:col-span-4 bg-muted rounded-lg overflow-hidden flex items-center justify-center relative aspect-video md:aspect-auto">
          <video 
            ref={remoteVideoRef} 
            className="w-full h-full object-cover" 
            autoPlay 
            playsInline
            style={{ display: remoteStream && hasMediaPermission ? 'block' : 'none' }}
          />
          {(!remoteStream && hasMediaPermission) && (
            <div className="flex flex-col items-center text-muted-foreground p-4 text-center">
              {isConnecting ? (
                <>
                  <Loader2 className="h-12 w-12 animate-spin mb-2" />
                  <p> {isCaller === null ? "Initializing..." : (isCaller ? "Calling..." : "Attempting to join...")} </p>
                  {isCaller !== null && <p className="text-xs mt-1">Waiting for other user to connect.</p>}
                </>
              ) : (
                 callEndedByRemote ? (
                    <>
                        <VideoOff className="h-16 w-16 mb-2 opacity-50" />
                        <p>Call has ended.</p>
                    </>
                 ) : (
                    <>
                        <VideoOff className="h-16 w-16 mb-2 opacity-50" />
                        <p>Waiting for remote video...</p>
                        <p className="text-xs mt-1">If this persists, the other user might not have camera enabled or there's a connection issue.</p>
                    </>
                 )
              )}
            </div>
          )}
           {hasMediaPermission && remoteStream && <p className="absolute bottom-4 left-4 bg-black/50 text-white px-2 py-1 rounded text-sm">Remote User</p>}
        </div>

        {/* Local Video and Info */}
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
              {(!localStream || isCameraOff || !hasMediaPermission ) && ( // Show placeholder if no stream, camera is off, or no permission
                 <div className="w-full h-full bg-muted flex items-center justify-center">
                    {/* Differentiate placeholder based on state */}
                    {!hasMediaPermission && <AlertTriangle className="h-12 w-12 text-destructive/70" />}
                    {hasMediaPermission && isCameraOff && localStream && <VideoOff className="h-12 w-12 text-foreground/50" />}
                    {hasMediaPermission && (!localStream || (!isCameraOff && !localStream.getVideoTracks().find(t=>t.enabled))) && <UserIcon className="h-12 w-12 text-foreground/50" />}
                 </div>
              )}
             {hasMediaPermission && localStream && <p className="absolute bottom-2 left-2 bg-black/50 text-white px-1.5 py-0.5 rounded text-xs">
                You {isMuted && "(Muted)"} {isCameraOff && "(Cam Off)"}
              </p>}
            </div>
            <div className="hidden md:block p-2 bg-muted/50 rounded-lg text-center text-xs text-foreground/70 overflow-auto">
              <p className="font-semibold mb-1 truncate">Call ID: {callId}</p>
              <p>Status: {isConnecting ? "Connecting..." : (remoteStream ? "Connected" : (callEndedByRemote ? "Ended" : "Waiting"))}</p>
              {peerConnectionRef.current && <p className="text-xs mt-0.5">PC: {peerConnectionRef.current.signalingState} / ICE: {peerConnectionRef.current.iceConnectionState}</p>}
            </div>
        </div>
      </div>

      <Card className="absolute bottom-4 left-1/2 transform -translate-x-1/2 shadow-xl bg-card/80 backdrop-blur-sm z-20">
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
          <Button variant="destructive" size="icon" onClick={handleLocalEndCall} aria-label="End call"> {/* Always enable end call button to allow cleanup */}
            <PhoneOff className="h-5 w-5" />
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
