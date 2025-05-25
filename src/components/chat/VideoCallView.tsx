
"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Mic, MicOff, PhoneOff, Video, VideoOff, Loader2, User as UserIcon, AlertTriangle } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { User as AuthUser } from "@/types";
import { doc, onSnapshot, setDoc, updateDoc, collection, addDoc, getDoc, deleteDoc, serverTimestamp, query, getDocs, writeBatch, Unsubscribe } from "firebase/firestore";
import { firestore } from "@/lib/firebase";

interface VideoCallViewProps {
  callId: string;
  onEndCall: () => void;
  localUser: AuthUser;
  isAudioOnly: boolean;
}

const stunServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function VideoCallView({ callId, onEndCall, localUser, isAudioOnly }: VideoCallViewProps) {
  const { toast } = useToast();

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(isAudioOnly);
  const [hasMediaPermission, setHasMediaPermission] = useState<boolean | null>(null);
  const [isConnecting, setIsConnecting] = useState(true);
  const [isCaller, setIsCaller] = useState<boolean | null>(null); // True if this client initiated the call doc
  
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  
  const iceCandidateListenersUnsubscribeRef = useRef<Unsubscribe[]>([]);
  const callDocUnsubscribeRef = useRef<Unsubscribe | null>(null);
  const localUserInitiatedEndRef = useRef(false); // To track if the local user explicitly ended the call

  const cleanupCall = useCallback(async (isLocalInitiated = false) => {
    console.log(`VideoCallView: cleanupCall triggered. callId: ${callId}, Local initiated: ${isLocalInitiated}, PC exists: ${!!peerConnectionRef.current}`);
    localUserInitiatedEndRef.current = isLocalInitiated;
    
    iceCandidateListenersUnsubscribeRef.current.forEach(unsubscribe => unsubscribe());
    iceCandidateListenersUnsubscribeRef.current = [];
    
    if (callDocUnsubscribeRef.current) {
      console.log("VideoCallView: Unsubscribing from call document.");
      callDocUnsubscribeRef.current();
      callDocUnsubscribeRef.current = null;
    }

    if (localStreamRef.current) {
      console.log("VideoCallView: Stopping local stream tracks.");
      localStreamRef.current.getTracks().forEach(track => track.stop());
      if (localVideoRef.current) {
          localVideoRef.current.srcObject = null; 
      }
      localStreamRef.current = null;
    }
     if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
    }
    remoteStreamRef.current = null; // Clear remote stream state

    const pc = peerConnectionRef.current;
    if (pc) {
      console.log("VideoCallView: Closing peer connection. Current state:", pc.signalingState, pc.iceConnectionState);
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.onsignalingstatechange = null;
      pc.oniceconnectionstatechange = null;
      if (pc.signalingState !== 'closed') {
        pc.close();
      }
      peerConnectionRef.current = null;
    }
    
    // Firestore cleanup for the call document and its subcollections
    if (callId && localUser && isLocalInitiated) {
      const callDocRef = doc(firestore, 'calls', callId);
      try {
        const callDocSnap = await getDoc(callDocRef);
        if (callDocSnap.exists()) {
          const callData = callDocSnap.data();
          // Delete if this user was the caller, or if this user was the callee AND the caller already ended or isn't there.
          // For a fixed ID, if one participant leaves, the call document should ideally be deleted to allow a clean start.
          // Or, status updated to 'ended' so new joiners know.
          // Given it's a fixed channel, simpler to delete if the local user explicitly ends.
          console.log("VideoCallView: Local user initiated end. Deleting call document and subcollections for callId:", callId);
          const batch = writeBatch(firestore);
          const callerCandidatesQuery = query(collection(firestore, `calls/${callId}/callerCandidates`));
          const callerCandidatesSnap = await getDocs(callerCandidatesQuery);
          callerCandidatesSnap.forEach(doc => batch.delete(doc.ref));
          
          const calleeCandidatesQuery = query(collection(firestore, `calls/${callId}/calleeCandidates`));
          const calleeCandidatesSnap = await getDocs(calleeCandidatesQuery);
          calleeCandidatesSnap.forEach(doc => batch.delete(doc.ref));
          
          batch.delete(callDocRef);
          await batch.commit();
          console.log("VideoCallView: Call document and subcollections deleted by local user.");
        }
      } catch (error) {
        console.error("VideoCallView: Error during Firestore cleanup in cleanupCall:", error);
      }
    }
    console.log("VideoCallView: cleanupCall finished for callId:", callId);
  }, [callId, localUser]); 

  // Main effect for call initialization and management
  useEffect(() => {
    console.log(`VideoCallView: useEffect for call initialization. callId: ${callId}, localUser: ${localUser?.uid}, isAudioOnly: ${isAudioOnly}`);
    let pcInstance: RTCPeerConnection;
    let mediaAcquiredSuccessfully = false;
    localUserInitiatedEndRef.current = false; // Reset for new call/mount

    const initialize = async () => {
      console.log("VideoCallView: initialize() started.");
      setIsConnecting(true);
      setHasMediaPermission(null); // Reset permission status

      try {
        console.log("VideoCallView: Requesting media devices with constraints:", { video: !isAudioOnly, audio: true });
        const stream = await navigator.mediaDevices.getUserMedia({ video: !isAudioOnly, audio: true });
        console.log("VideoCallView: Media devices acquired successfully.");
        
        if (isAudioOnly) {
            stream.getVideoTracks().forEach(track => { track.enabled = false; track.stop(); }); // Stop and disable
        } else {
            stream.getVideoTracks().forEach(track => track.enabled = !isCameraOff);
        }
        stream.getAudioTracks().forEach(track => track.enabled = !isMuted);

        localStreamRef.current = stream;
        setHasMediaPermission(true);
        mediaAcquiredSuccessfully = true;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        pcInstance = new RTCPeerConnection(stunServers);
        peerConnectionRef.current = pcInstance;
        console.log("VideoCallView: RTCPeerConnection created.");

        localStreamRef.current.getTracks().forEach(track => pcInstance.addTrack(track, localStreamRef.current!));

        pcInstance.onicecandidate = event => {
          console.log("VideoCallView: onicecandidate. Candidate:", event?.candidate ? "Yes" : "No", "Current isCaller state:", isCaller);
          if (event.candidate && callId && isCaller !== null) { 
            const candidatesCollectionPath = isCaller ? `calls/${callId}/callerCandidates` : `calls/${callId}/calleeCandidates`;
            addDoc(collection(firestore, candidatesCollectionPath), event.candidate.toJSON())
              .catch(e => console.error("VideoCallView: Error adding ICE candidate to Firestore:", e));
          }
        };

        pcInstance.ontrack = event => {
          console.log("VideoCallView: ontrack event. Streams:", event.streams.length > 0 ? event.streams[0] : "No stream[0]");
          if (event.streams && event.streams[0]) {
            remoteStreamRef.current = event.streams[0];
            if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = event.streams[0];
            }
          }
        };
        
        pcInstance.onconnectionstatechange = () => {
          console.log("VideoCallView: Peer connection state changed to:", pcInstance?.connectionState);
          if (pcInstance?.connectionState === 'connected') {
            setIsConnecting(false);
          } else if (['disconnected', 'failed', 'closed'].includes(pcInstance?.connectionState || '')) {
             console.warn("VideoCallView: Peer connection state is disconnected, failed, or closed:", pcInstance?.connectionState);
             if (!localUserInitiatedEndRef.current) { // Only end if not initiated by local user
                 onEndCall(); 
             }
          }
        };

        pcInstance.onsignalingstatechange = () => console.log("VideoCallView: Peer signaling state changed to:", pcInstance?.signalingState);
        pcInstance.oniceconnectionstatechange = () => {
            console.log("VideoCallView: Peer ICE connection state changed to:", pcInstance?.iceConnectionState);
             if (pcInstance?.iceConnectionState === 'failed' && !localUserInitiatedEndRef.current) {
                console.error("VideoCallView: ICE connection failed.");
                toast({variant: "destructive", title: "Connection Failed", description: "Could not establish a stable connection."});
                onEndCall();
            }
        };

        const callDocRef = doc(firestore, 'calls', callId);
        const callDocSnap = await getDoc(callDocRef);
        let localIsCallerDetermination: boolean; // To be decided based on callDocSnap

        if (!callDocSnap.exists() || (callDocSnap.exists() && ['ended', 'ended_by_caller', 'ended_by_callee'].includes(callDocSnap.data()?.status))) {
          if(callDocSnap.exists()){
            console.log("VideoCallView: Stale/ended call document found. Cleaning up before becoming caller.", callDocSnap.data());
            const batch = writeBatch(firestore);
            const oldCallerCandidates = await getDocs(query(collection(firestore, `calls/${callId}/callerCandidates`)));
            oldCallerCandidates.forEach((d) => batch.delete(d.ref));
            const oldCalleeCandidates = await getDocs(query(collection(firestore, `calls/${callId}/calleeCandidates`)));
            oldCalleeCandidates.forEach((d) => batch.delete(d.ref));
            batch.delete(callDocRef);
            await batch.commit();
            console.log("VideoCallView: Deleted stale call document and candidates for fixed call ID:", callId);
          }
          
          localIsCallerDetermination = true;
          setIsCaller(true);
          console.log("VideoCallView: Current user is Caller. Creating offer.");
          const offerDescription = await pcInstance.createOffer();
          await pcInstance.setLocalDescription(offerDescription);
          console.log("VideoCallView: Local description (offer) set.");

          const callDataForCreate = {
            callerId: localUser.uid,
            callerName: localUser.displayName || "Anonymous Caller",
            offer: { type: offerDescription.type, sdp: offerDescription.sdp },
            status: 'ringing',
            createdAt: serverTimestamp(),
            calleeId: null, 
            isAudioOnly: isAudioOnly,
          };
          await setDoc(callDocRef, callDataForCreate);
          console.log("VideoCallView: Caller: Call document created with offer.");
        } else {
          const callData = callDocSnap.data();
          console.log("VideoCallView: Existing call document found:", callData);

          if (callData.isAudioOnly !== isAudioOnly) {
            toast({variant: "destructive", title: "Call Type Mismatch", description: `This call is ${callData.isAudioOnly ? 'audio-only' : 'video'}. You tried to join with a different type.`});
            onEndCall(); return;
          }

          if (callData.callerId === localUser.uid) { // Current user is the original caller
            localIsCallerDetermination = true;
            setIsCaller(true);
            console.log("VideoCallView: Current user is original Caller, re-establishing. PC signaling state:", pcInstance.signalingState);
            if (callData.offer && pcInstance.signalingState === 'stable') { // only set if not already set
                await pcInstance.setLocalDescription(new RTCSessionDescription(callData.offer));
            }
            if (callData.answer && pcInstance.signalingState === 'have-local-offer') { // only set if remote not already set
                await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.answer));
            }
            // If both descriptions are set, connection might establish or might be waiting for ICE.
            if (pcInstance.currentRemoteDescription && pcInstance.currentLocalDescription) setIsConnecting(false);


          } else if (callData.status === 'ringing' && !callData.calleeId) { // Call is ringing and available
            localIsCallerDetermination = false;
            setIsCaller(false);
            console.log("VideoCallView: Current user is Callee, joining ringing call.");
            
            if (pcInstance.signalingState !== 'stable' && pcInstance.signalingState !== 'have-remote-offer') {
                console.warn("VideoCallView: Callee: PC not in 'stable' or 'have-remote-offer' state before setRemoteDescription. State:", pcInstance.signalingState);
            }
            await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.offer));
            console.log("VideoCallView: Callee: Remote description (offer) set.");
            
            const answerDescription = await pcInstance.createAnswer();
            await pcInstance.setLocalDescription(answerDescription);
            console.log("VideoCallView: Callee: Local description (answer) set.");

            await updateDoc(callDocRef, {
              calleeId: localUser.uid,
              calleeName: localUser.displayName || "Anonymous Callee",
              answer: { type: answerDescription.type, sdp: answerDescription.sdp },
              status: 'active',
              joinedAt: serverTimestamp(),
            });
            console.log("VideoCallView: Callee: Call document updated with answer, status active.");
            setIsConnecting(false);
          } else if (callData.status === 'active' && callData.calleeId && callData.calleeId !== localUser.uid) { // Call is active with someone else
            console.warn("VideoCallView: Call is busy with another participant.");
            toast({variant: "destructive", title: "Call Busy", description: "This call is already in progress with another participant."});
            onEndCall(); return; 
          } else if (callData.status === 'active' && callData.calleeId === localUser.uid) { // Callee rejoining an active call
            localIsCallerDetermination = false;
            setIsCaller(false);
            console.log("VideoCallView: Callee rejoining active call. PC signaling state:", pcInstance.signalingState);
             if (callData.offer && pcInstance.signalingState === 'stable') {
                 await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.offer));
            }
            if (callData.answer && (pcInstance.signalingState === 'have-remote-offer' || pcInstance.signalingState === 'stable' && !pcInstance.currentLocalDescription)) {
                await pcInstance.setLocalDescription(new RTCSessionDescription(callData.answer));
            }
            if (pcInstance.currentRemoteDescription && pcInstance.currentLocalDescription) setIsConnecting(false);

          } else {
            console.warn("VideoCallView: Call document in unexpected state. Treating as new call for this user.", callData);
            // This case might mean the call doc is in a weird state, let this user become a new caller
            // Potentially clean up old doc first
             const batch = writeBatch(firestore);
            const oldCallerCandidates = await getDocs(query(collection(firestore, `calls/${callId}/callerCandidates`)));
            oldCallerCandidates.forEach((d) => batch.delete(d.ref));
            const oldCalleeCandidates = await getDocs(query(collection(firestore, `calls/${callId}/calleeCandidates`)));
            oldCalleeCandidates.forEach((d) => batch.delete(d.ref));
            batch.delete(callDocRef); // Delete the problematic doc
            await batch.commit();
            console.log("VideoCallView: Deleted unexpected state call document.");

            // Retry initialization: This might cause a loop if not careful. Simpler to just become caller.
            localIsCallerDetermination = true;
            setIsCaller(true);
            const offerDescription = await pcInstance.createOffer();
            await pcInstance.setLocalDescription(offerDescription);
            const callDataForCreate = { /* ... as above ... */ 
                callerId: localUser.uid, callerName: localUser.displayName || "Anonymous Caller",
                offer: { type: offerDescription.type, sdp: offerDescription.sdp }, status: 'ringing',
                createdAt: serverTimestamp(), calleeId: null, isAudioOnly: isAudioOnly,
            };
            await setDoc(callDocRef, callDataForCreate);
            console.log("VideoCallView: Became new caller after unexpected state.");
          }
        }
        
        // Set isCaller state after determination
        setIsCaller(localIsCallerDetermination);

        // Setup ICE candidate listeners based on determined role
        const remoteCandidatesCollectionName = localIsCallerDetermination ? "calleeCandidates" : "callerCandidates";
        const unsubRemoteCandidates = onSnapshot(collection(firestore, `calls/${callId}/${remoteCandidatesCollectionName}`), snapshot => {
          snapshot.docChanges().forEach(async change => { 
            if (change.type === 'added') {
              const candidate = change.doc.data();
              console.log(`VideoCallView: Received remote ICE candidate from ${remoteCandidatesCollectionName}:`, candidate);
              try {
                if (peerConnectionRef.current && peerConnectionRef.current.signalingState !== 'closed') { 
                  await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
                }
              } catch (e) {
                console.error("VideoCallView: Error adding remote ICE candidate:", e, "Signaling state:", peerConnectionRef.current?.signalingState);
              }
            }
          });
        });
        iceCandidateListenersUnsubscribeRef.current.push(unsubRemoteCandidates);
        
        // Setup listener for call document changes
        callDocUnsubscribeRef.current = onSnapshot(callDocRef, async (snapshot) => { 
          const data = snapshot.data();
          console.log("VideoCallView: Call document update. Exists:", snapshot.exists(), "Data:", data, "PC State:", peerConnectionRef.current?.signalingState);

          if (!snapshot.exists()) {
            if (!localUserInitiatedEndRef.current) {
                console.log("VideoCallView: Call document deleted remotely.");
                toast({title: "Call Ended", description: "The call has concluded."});
                onEndCall();
            }
            return;
          }
          
          const pc = peerConnectionRef.current;
          if (!pc || pc.signalingState === 'closed') return;

          if (isCaller === true && data?.answer && !pc.currentRemoteDescription) {
            console.log("VideoCallView: Caller: Detected answer. Current PC signaling state:", pc.signalingState);
            if (pc.signalingState === 'have-local-offer' || pc.signalingState === 'stable') {
                 try {
                    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                    console.log("VideoCallView: Caller: Remote description (answer) set.");
                    setIsConnecting(false); 
                } catch (e) {
                    console.error("VideoCallView: Caller: Error setting remote description (answer):", e);
                }
            } else {
                 console.warn("VideoCallView: Caller: Received answer but PC not in 'have-local-offer' or 'stable' state. State:", pc.signalingState);
            }
          }

          if (data?.status && ['ended', 'ended_by_caller', 'ended_by_callee'].includes(data.status)) {
            const remotelyEnded = (isCaller === false && data.status === 'ended_by_caller') || (isCaller === true && data.status === 'ended_by_callee');
            if ((remotelyEnded || data.status === 'ended') && !localUserInitiatedEndRef.current) {
                console.log("VideoCallView: Call ended by other party or globally. Status:", data.status);
                toast({title: "Call Ended", description: "The other user has ended the call."});
                onEndCall(); 
            }
          }
        });

      } catch (error: any) {
        console.error('VideoCallView: Error during initialize function:', error, error.stack);
        let title = 'Media Access Error';
        let description = `Could not start ${isAudioOnly ? 'audio' : 'video'} call.`;

        if (mediaAcquiredSuccessfully) {
          title = 'Call Setup Error';
          description = `Failed to set up the call. ${error.message || 'Please try again.'}`;
        } else {
          setHasMediaPermission(false); 
          if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            description = 'Camera and microphone access was denied. Please enable it in your browser settings and refresh.';
          } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
            description = 'No camera or microphone found. Please ensure they are connected and enabled.';
          } else {
             description = error.message || 'An unexpected error occurred while accessing media devices.';
          }
        }
        toast({ variant: 'destructive', title, description, duration: 7000 });
        onEndCall(); 
      }
    };

    if (localUser?.uid && callId) { 
        initialize();
    } else {
        console.error("VideoCallView: Local user or callId not available, cannot initialize call.");
        onEndCall();
    }

    return () => {
      console.log("VideoCallView: useEffect cleanup for callId:", callId, "localUserInitiatedEndRef:", localUserInitiatedEndRef.current);
      // cleanupCall will be invoked by the onEndCall prop when the component unmounts or callId changes
      // or if handleLocalEndCall directly calls it after updating Firestore.
      // The primary purpose here is that if onEndCall itself causes unmount, cleanup is done.
      // We ensure cleanupCall is robust against multiple calls.
      if (!localUserInitiatedEndRef.current) { // If unmounting due to external reason (e.g. parent changes)
        cleanupCall(false); // Indicate it wasn't a local user action that led to this specific cleanup trigger
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, localUser?.uid, isAudioOnly]); // onEndCall and toast are stable

  const handleLocalEndCall = async () => {
    console.log("VideoCallView: User clicked end call button for callId:", callId);
    localUserInitiatedEndRef.current = true; // Mark that this user initiated the end

    if (callId && localUser && peerConnectionRef.current) {
        const callDocRef = doc(firestore, 'calls', callId);
        try {
            const callDocSnap = await getDoc(callDocRef);
            if (callDocSnap.exists()) {
                const callData = callDocSnap.data();
                let newStatus = callData.status;
                
                if (isCaller === true && callData.status !== 'ended_by_caller') {
                    newStatus = 'ended_by_caller';
                } else if (isCaller === false && callData.status !== 'ended_by_callee') {
                    newStatus = 'ended_by_callee';
                }

                // If the other party already ended, this end call becomes a full cleanup/delete.
                const otherPartyEnded = (isCaller === true && callData.status === 'ended_by_callee') ||
                                        (isCaller === false && callData.status === 'ended_by_caller');

                if (otherPartyEnded || newStatus === 'ended_by_caller' || newStatus === 'ended_by_callee') {
                   // If this action effectively ends the call for everyone or it was already ended by other
                   // we can proceed to full cleanup which includes deleting the doc.
                   console.log("VideoCallView: handleLocalEndCall leading to full cleanup/deletion.");
                   // cleanupCall(true) will handle deletion, no need to updateDoc first if deleting.
                } else if (callData.status !== newStatus) { // Update status if it changed
                    await updateDoc(callDocRef, { status: newStatus, endedAt: serverTimestamp() });
                    console.log("VideoCallView: Updated call status to", newStatus, "for callId:", callId);
                }
            }
        } catch (error) {
            console.error("VideoCallView: Error updating call status on end:", error);
        }
    }
    // Call cleanupCall directly after handling Firestore updates to ensure immediate resource release.
    // onEndCall (from parent) will then handle UI state changes (like hiding VideoCallView).
    await cleanupCall(true); 
    onEndCall(); // Notify parent to update its state (e.g., setIsCallActive(false))
  };

  const toggleMute = () => {
    setIsMuted(prev => {
      const newMutedState = !prev;
      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach(track => track.enabled = !newMutedState);
      }
      return newMutedState;
    });
  };

  const toggleCamera = () => {
    if (isAudioOnly) return;
     setIsCameraOff(prev => {
        const newCameraOffState = !prev;
        if (localStreamRef.current) {
            localStreamRef.current.getVideoTracks().forEach(track => track.enabled = !newCameraOffState);
        }
        return newCameraOffState;
    });
  };
  
  if (hasMediaPermission === null && isConnecting) { // Show only during initial permission request
    return (
      <div className="flex flex-col h-full p-4 bg-card items-center justify-center">
        <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
        <p className="text-muted-foreground">Requesting media permissions...</p>
      </div>
    );
  }
  
  return (
    <div className="flex flex-col h-full p-4 bg-card items-center justify-center relative">
      {hasMediaPermission === false && ( 
        <Alert variant="destructive" className="mb-4 absolute top-4 left-1/2 -translate-x-1/2 z-10 max-w-lg w-full">
          <AlertTitle>Media Access Required</AlertTitle>
          <AlertDescription>
            Calling requires camera and/or microphone access. 
            Please enable permissions in your browser settings and try starting the call again.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 w-full h-full flex-1">
        <div className="md:col-span-4 bg-muted rounded-lg overflow-hidden flex items-center justify-center relative aspect-video md:aspect-auto">
          {isAudioOnly && !remoteStreamRef.current && (
            <div className="flex flex-col items-center text-muted-foreground p-4 text-center">
                <UserIcon className="h-24 w-24 mb-4 opacity-30" />
                {isConnecting ? (
                    <>
                        <Loader2 className="h-10 w-10 animate-spin mb-2" />
                        <p>Connecting audio call...</p>
                        {(isCaller !== null && peerConnectionRef.current?.connectionState !== 'connected') && <p className="text-xs mt-1">Waiting for other user to connect.</p>}
                    </>
                ) : (
                    <p>Waiting for remote audio...</p>
                )}
            </div>
          )}
          {isAudioOnly && remoteStreamRef.current && (
            <div className="flex flex-col items-center text-muted-foreground p-4 text-center">
                <UserIcon className="h-32 w-32 mb-4 opacity-60" />
                <p className="text-lg font-medium">Connected to Remote User (Audio)</p>
            </div>
          )}
          <video 
            ref={remoteVideoRef} 
            className="w-full h-full object-cover" 
            autoPlay 
            playsInline
            style={{ display: remoteStreamRef.current && hasMediaPermission && !isAudioOnly ? 'block' : 'none' }}
          />
          {(!remoteStreamRef.current && hasMediaPermission && !isAudioOnly) && (
            <div className="flex flex-col items-center text-muted-foreground p-4 text-center">
              {isConnecting && peerConnectionRef.current?.connectionState !== 'connected' ? (
                <>
                  <Loader2 className="h-12 w-12 animate-spin mb-2" />
                  <p> {isCaller === null ? "Initializing..." : (isCaller ? `Calling (${isAudioOnly ? 'Audio' : 'Video'})...` : `Attempting to join (${isAudioOnly ? 'Audio' : 'Video'})...`)} </p>
                  {(isCaller !== null && peerConnectionRef.current?.connectionState !== 'connected') && <p className="text-xs mt-1">Waiting for other user to connect.</p>}
                </>
              ) : (
                 peerConnectionRef.current?.connectionState === 'closed' || peerConnectionRef.current?.connectionState === 'failed' ? (
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
           {hasMediaPermission && remoteStreamRef.current && !isAudioOnly && <p className="absolute bottom-4 left-4 bg-black/50 text-white px-2 py-1 rounded text-sm">Remote User</p>}
        </div>

        <div className="md:col-span-1 flex flex-col gap-4">
            <div className="bg-muted rounded-lg overflow-hidden aspect-video relative flex-shrink-0">
              {isAudioOnly ? (
                <div className="w-full h-full bg-muted flex flex-col items-center justify-center text-foreground/60 p-2">
                    <UserIcon className="h-16 w-16 mb-2 opacity-80" />
                    <p className="text-sm font-medium">Your Audio</p>
                    {isMuted && <p className="text-xs">(Muted)</p>}
                </div>
              ) : (
                <>
                  <video 
                    ref={localVideoRef} 
                    className="w-full h-full object-cover" 
                    autoPlay 
                    muted 
                    playsInline 
                    style={{ display: localStreamRef.current && !isCameraOff && hasMediaPermission ? 'block' : 'none' }}
                  />
                  {(!localStreamRef.current || isCameraOff || !hasMediaPermission ) && ( 
                     <div className="w-full h-full bg-muted flex items-center justify-center">
                        {!hasMediaPermission && localStreamRef.current === null && <AlertTriangle className="h-12 w-12 text-destructive/70" />}
                        {hasMediaPermission && isCameraOff && localStreamRef.current && <VideoOff className="h-12 w-12 text-foreground/50" />}
                        {hasMediaPermission && (!localStreamRef.current || (!isCameraOff && localStreamRef.current?.getVideoTracks().every(t => !t.enabled))) && <UserIcon className="h-12 w-12 text-foreground/50" />}
                     </div>
                  )}
                </>
              )}
             {hasMediaPermission && localStreamRef.current && !isAudioOnly && <p className="absolute bottom-2 left-2 bg-black/50 text-white px-1.5 py-0.5 rounded text-xs">
                You {isMuted && "(Muted)"} {isCameraOff && "(Cam Off)"}
              </p>}
            </div>
            <div className="hidden md:block p-2 bg-muted/50 rounded-lg text-center text-xs text-foreground/70 overflow-auto">
              <p className="font-semibold mb-1 truncate">Call ID: {callId}</p>
              <p>Type: {isAudioOnly ? 'Audio Call' : 'Video Call'}</p>
              <p>Status: {isConnecting && peerConnectionRef.current?.connectionState !== 'connected' ? "Connecting..." : (remoteStreamRef.current ? "Connected" : (peerConnectionRef.current?.connectionState === 'closed' || peerConnectionRef.current?.connectionState === 'failed' ? "Ended" : "Waiting"))}</p>
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
            disabled={!localStreamRef.current || hasMediaPermission === false}
          >
            {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </Button>
          <Button 
            variant={isCameraOff || isAudioOnly ? "destructive" : "secondary"} 
            size="icon" 
            onClick={toggleCamera} 
            aria-label={isCameraOff ? "Turn camera on" : "Turn camera off"}
            disabled={!localStreamRef.current || hasMediaPermission === false || isAudioOnly}
            title={isAudioOnly ? "Camera disabled for audio call" : (isCameraOff ? "Turn camera on" : "Turn camera off")}
          >
            {isCameraOff || isAudioOnly ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
          </Button>
          <Button variant="destructive" size="icon" onClick={handleLocalEndCall} aria-label="End call"> 
            <PhoneOff className="h-5 w-5" />
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

