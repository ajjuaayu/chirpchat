
"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Mic, MicOff, PhoneOff, Video, VideoOff, Loader2, User as UserIcon, AlertTriangle } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { User as AuthUser } from "@/types";
import { doc, onSnapshot, setDoc, updateDoc, collection, addDoc, getDoc, deleteDoc, serverTimestamp, query, getDocs, writeBatch, Unsubscribe, DocumentSnapshot } from "firebase/firestore";
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
  const [isCaller, setIsCaller] = useState<boolean | null>(null); 
  const isCallerRef = useRef<boolean | null>(null);
  
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  
  const iceCandidateListenersUnsubscribeRef = useRef<Unsubscribe[]>([]);
  const callDocUnsubscribeRef = useRef<Unsubscribe | null>(null);
  const localUserInitiatedEndRef = useRef(false);

  const cleanupCall = useCallback(async (isLocalInitiated = false) => {
    console.log(`VideoCallView: cleanupCall triggered. callId: ${callId}, Local initiated: ${isLocalInitiated}, PC exists: ${!!peerConnectionRef.current}`);
    if (!isLocalInitiated) { // If not locally initiated, mark it for the useEffect cleanup return
        localUserInitiatedEndRef.current = false; 
    }
    
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
    remoteStreamRef.current = null; 

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
    
    if (callId && localUser && isLocalInitiated) {
      const callDocRef = doc(firestore, 'calls', callId);
      try {
        const callDocSnap = await getDoc(callDocRef);
        if (callDocSnap.exists()) {
          const callData = callDocSnap.data();
          const userIsCaller = callData.callerId === localUser.uid;
          const userIsCallee = callData.calleeId === localUser.uid;

          const otherPartyEnded = (userIsCaller && callData.status === 'ended_by_callee') ||
                                  (userIsCallee && callData.status === 'ended_by_caller');
          
          // Delete if this user ended and the other party also ended, or if it's just 'ended' (from a full cleanup)
          // Or if this user is the sole active participant ending the call (e.g., caller ends before callee joins)
          const shouldDelete = otherPartyEnded || 
                               callData.status === 'ended' || 
                               (userIsCaller && !callData.calleeId && callData.status === 'ended_by_caller') ||
                               (userIsCallee && !callData.callerId && callData.status === 'ended_by_callee');


          if (shouldDelete) {
            console.log("VideoCallView: Local user initiated end & conditions met for deletion. Deleting call document and subcollections for callId:", callId);
            const batch = writeBatch(firestore);
            const callerCandidatesQuery = query(collection(firestore, `calls/${callId}/callerCandidates`));
            const callerCandidatesSnap = await getDocs(callerCandidatesQuery);
            callerCandidatesSnap.forEach(docSn => batch.delete(docSn.ref));
            
            const calleeCandidatesQuery = query(collection(firestore, `calls/${callId}/calleeCandidates`));
            const calleeCandidatesSnap = await getDocs(calleeCandidatesQuery);
            calleeCandidatesSnap.forEach(docSn => batch.delete(docSn.ref));
            
            batch.delete(callDocRef);
            await batch.commit();
            console.log("VideoCallView: Call document and subcollections deleted by local user under callId:", callId);
          } else {
             console.log("VideoCallView: Call document status not 'ended' or conditions not met for deletion, status was:", callData.status, "isCaller:", userIsCaller, "isCallee:", userIsCallee);
          }
        }
      } catch (error) {
        console.error("VideoCallView: Error during Firestore cleanup in cleanupCall:", error);
      }
    }
    console.log("VideoCallView: cleanupCall finished for callId:", callId);
  }, [callId, localUser]); 

  useEffect(() => {
    console.log(`VideoCallView: useEffect for call initialization. callId: ${callId}, localUser: ${localUser?.uid}, isAudioOnly: ${isAudioOnly}`);
    let pcInstance: RTCPeerConnection;
    let mediaAcquiredSuccessfully = false;
    localUserInitiatedEndRef.current = false; 

    const initialize = async () => {
      console.log("VideoCallView: initialize() started.");
      setIsConnecting(true);
      setHasMediaPermission(null); 

      try {
        console.log("VideoCallView: Requesting media devices with constraints:", { video: !isAudioOnly, audio: true });
        const stream = await navigator.mediaDevices.getUserMedia({ video: !isAudioOnly, audio: true });
        console.log("VideoCallView: Media devices acquired successfully.");
        
        if (isAudioOnly) {
            stream.getVideoTracks().forEach(track => { track.enabled = false; track.stop(); }); 
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
          console.log("VideoCallView: onicecandidate. Candidate:", event?.candidate ? "Yes" : "No", "Current isCallerRef.current:", isCallerRef.current);
          if (event.candidate && callId && isCallerRef.current !== null) { 
            const candidatesCollectionPath = isCallerRef.current ? `calls/${callId}/callerCandidates` : `calls/${callId}/calleeCandidates`;
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
             if (!localUserInitiatedEndRef.current) { 
                 onEndCall(); 
             }
          }
        };

        pcInstance.onsignalingstatechange = () => {
            const oldState = pcInstance?.signalingState; // Capture for logging if needed, though not directly here
            console.log("VideoCallView: Peer signaling state changed to:", pcInstance?.signalingState, "(was:",oldState,")");
        }
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
        let localIsCallerDetermination: boolean; 

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
          isCallerRef.current = true;
          setIsCaller(true);
          console.log("VideoCallView: Current user is Caller. Creating offer. PC state:", pcInstance.signalingState);
          if (pcInstance.signalingState === 'stable') {
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
            console.error("VideoCallView: Caller: Cannot create offer, PC not in 'stable' state. State:", pcInstance.signalingState);
            throw new Error("PeerConnection not stable for creating offer.");
          }
        } else {
          const callData = callDocSnap.data();
          console.log("VideoCallView: Existing call document found:", callData, "PC state:", pcInstance.signalingState);

          if (callData.isAudioOnly !== isAudioOnly) {
            toast({variant: "destructive", title: "Call Type Mismatch", description: `This call is ${callData.isAudioOnly ? 'audio-only' : 'video'}. You tried to join with a different type.`});
            onEndCall(); return;
          }

          if (callData.callerId === localUser.uid) { 
            localIsCallerDetermination = true;
            isCallerRef.current = true;
            setIsCaller(true);
            console.log("VideoCallView: Current user is original Caller, re-establishing. PC signaling state:", pcInstance.signalingState, "Local desc:", pcInstance.currentLocalDescription, "Remote desc:", pcInstance.currentRemoteDescription);
            
            if (callData.offer && !pcInstance.currentLocalDescription && pcInstance.signalingState === 'stable') {
                console.log("VideoCallView: Caller re-establishing: Setting local description (offer) from DB.");
                await pcInstance.setLocalDescription(new RTCSessionDescription(callData.offer));
            } else if (callData.offer && !pcInstance.currentLocalDescription) {
                console.warn("VideoCallView: Caller re-establishing: Cannot set local offer, PC not in 'stable' state. State:", pcInstance.signalingState);
            }
            
            if (callData.answer && !pcInstance.currentRemoteDescription && (pcInstance.signalingState === 'have-local-offer' || (pcInstance.signalingState === 'stable' && pcInstance.currentLocalDescription))) {
                console.log("VideoCallView: Caller re-establishing: Setting remote description (answer) from DB.");
                await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.answer));
            } else if (callData.answer && !pcInstance.currentRemoteDescription) {
                 console.warn("VideoCallView: Caller re-establishing: Cannot set remote answer. PC State:", pcInstance.signalingState);
            }
            if (pcInstance.currentRemoteDescription && pcInstance.currentLocalDescription) setIsConnecting(false);

          } else if (callData.status === 'ringing' && !callData.calleeId) { 
            localIsCallerDetermination = false;
            isCallerRef.current = false;
            setIsCaller(false); 
            console.log("VideoCallView: Current user is Callee, joining ringing call. PC state:", pcInstance.signalingState);
            
            if (pcInstance.signalingState === 'stable') {
                await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.offer));
                console.log("VideoCallView: Callee: Remote description (offer) set. PC state:", pcInstance.signalingState);
                
                if (pcInstance.signalingState === 'have-remote-offer') {
                    const answerDescription = await pcInstance.createAnswer();
                    await pcInstance.setLocalDescription(answerDescription);
                    console.log("VideoCallView: Callee: Local description (answer) set. PC state:", pcInstance.signalingState);

                    await updateDoc(callDocRef, {
                      calleeId: localUser.uid,
                      calleeName: localUser.displayName || "Anonymous Callee",
                      answer: { type: answerDescription.type, sdp: answerDescription.sdp },
                      status: 'active',
                      joinedAt: serverTimestamp(),
                    });
                    console.log("VideoCallView: Callee: Call document updated with answer, status active.");
                    setIsConnecting(false);
                } else {
                    console.error("VideoCallView: Callee: PC not in 'have-remote-offer' state after setting remote offer. State:", pcInstance.signalingState);
                    throw new Error("PeerConnection not in have-remote-offer state for creating answer.");
                }
            } else {
                console.error("VideoCallView: Callee: PC not in 'stable' state before setRemoteDescription. State:", pcInstance.signalingState);
                throw new Error("PeerConnection not stable for setting remote offer.");
            }
          } else if (callData.status === 'active' && callData.calleeId && callData.calleeId !== localUser.uid) { 
            console.warn("VideoCallView: Call is busy with another participant.");
            toast({variant: "destructive", title: "Call Busy", description: "This call is already in progress with another participant."});
            onEndCall(); return; 
          } else if (callData.status === 'active' && callData.calleeId === localUser.uid) { 
            localIsCallerDetermination = false;
            isCallerRef.current = false;
            setIsCaller(false); 
            console.log("VideoCallView: Callee rejoining active call. PC signaling state:", pcInstance.signalingState, "Local desc:", pcInstance.currentLocalDescription, "Remote desc:", pcInstance.currentRemoteDescription);
             
            if (callData.offer && !pcInstance.currentRemoteDescription && pcInstance.signalingState === 'stable') {
                console.log("VideoCallView: Callee rejoining: Setting remote description (offer) from DB.");
                await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.offer));
            } else if (callData.offer && !pcInstance.currentRemoteDescription) {
                console.warn("VideoCallView: Callee rejoining: Cannot set remote offer. PC State:", pcInstance.signalingState);
            }
            
            if (callData.answer && !pcInstance.currentLocalDescription && (pcInstance.signalingState === 'have-remote-offer' || (pcInstance.signalingState === 'stable' && pcInstance.currentRemoteDescription))) {
                 console.log("VideoCallView: Callee rejoining: Setting local description (answer) from DB.");
                await pcInstance.setLocalDescription(new RTCSessionDescription(callData.answer));
            } else if (callData.answer && !pcInstance.currentLocalDescription) {
                 console.warn("VideoCallView: Callee rejoining: Cannot set local answer. PC State:", pcInstance.signalingState);
            }
            if (pcInstance.currentRemoteDescription && pcInstance.currentLocalDescription) setIsConnecting(false);

          } else {
            console.warn("VideoCallView: Call document in unexpected state. User:", localUser.uid, "Call Data:", callData);
             const batch = writeBatch(firestore);
            const oldCallerCandidates = await getDocs(query(collection(firestore, `calls/${callId}/callerCandidates`)));
            oldCallerCandidates.forEach((d) => batch.delete(d.ref));
            const oldCalleeCandidates = await getDocs(query(collection(firestore, `calls/${callId}/calleeCandidates`)));
            oldCalleeCandidates.forEach((d) => batch.delete(d.ref));
            if(callDocSnap.exists()) batch.delete(callDocRef); 
            await batch.commit();
            console.log("VideoCallView: Deleted unexpected state call document. Will attempt to become new caller.");

            localIsCallerDetermination = true;
            isCallerRef.current = true;
            setIsCaller(true);
            if (pcInstance.signalingState === 'stable') {
                const offerDescription = await pcInstance.createOffer();
                await pcInstance.setLocalDescription(offerDescription);
                const callDataForCreate = { 
                    callerId: localUser.uid, callerName: localUser.displayName || "Anonymous Caller",
                    offer: { type: offerDescription.type, sdp: offerDescription.sdp }, status: 'ringing',
                    createdAt: serverTimestamp(), calleeId: null, isAudioOnly: isAudioOnly,
                };
                await setDoc(callDocRef, callDataForCreate);
                console.log("VideoCallView: Became new caller after unexpected state.");
            } else {
                 console.error("VideoCallView: Cannot become new caller after unexpected state, PC not stable. State:", pcInstance.signalingState);
                 throw new Error("PeerConnection not stable for creating offer after unexpected state.");
            }
          }
        }
        
        setIsCaller(localIsCallerDetermination);
        isCallerRef.current = localIsCallerDetermination;

        const remoteCandidatesCollectionName = isCallerRef.current ? "calleeCandidates" : "callerCandidates";
        console.log(`VideoCallView: Setting up listener for remote ICE candidates from ${remoteCandidatesCollectionName}`);
        const unsubRemoteCandidates = onSnapshot(collection(firestore, `calls/${callId}/${remoteCandidatesCollectionName}`), snapshot => {
          snapshot.docChanges().forEach(async change => { 
            if (change.type === 'added') {
              const candidate = change.doc.data();
              console.log(`VideoCallView: Received remote ICE candidate from ${remoteCandidatesCollectionName}:`, candidate, "PC State:", peerConnectionRef.current?.signalingState);
              try {
                if (peerConnectionRef.current && peerConnectionRef.current.signalingState !== 'closed' && candidate) { 
                  if (peerConnectionRef.current.remoteDescription || peerConnectionRef.current.currentRemoteDescription) {
                     await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
                  } else {
                     console.warn("VideoCallView: Did not add ICE candidate, remote description not yet set.");
                  }
                }
              } catch (e) {
                console.error("VideoCallView: Error adding remote ICE candidate:", e, "Signaling state:", peerConnectionRef.current?.signalingState);
              }
            }
          });
        });
        iceCandidateListenersUnsubscribeRef.current.push(unsubRemoteCandidates);
        
        callDocUnsubscribeRef.current = onSnapshot(callDocRef, async (snapshot: DocumentSnapshot) => { 
          const data = snapshot.data();
          console.log("VideoCallView: Call document update. Exists:", snapshot.exists(), "Data:", data, "PC State:", peerConnectionRef.current?.signalingState, "isCallerRef.current:", isCallerRef.current);

          if (!snapshot.exists()) {
            if (!localUserInitiatedEndRef.current) {
                console.log("VideoCallView: Call document deleted remotely.");
                // Avoid toast if already cleaning up due to local action
                if (!localUserInitiatedEndRef.current) {
                    toast({title: "Call Ended", description: "The call has concluded."});
                }
                onEndCall();
            }
            return;
          }
          
          const pc = peerConnectionRef.current;
          if (!pc || pc.signalingState === 'closed') return;

          if (isCallerRef.current === true && data?.answer && !pc.currentRemoteDescription) {
            console.log("VideoCallView: Caller (isCallerRef.current): Detected answer. Current PC signaling state:", pc.signalingState);
            if (pc.signalingState === 'have-local-offer' || (pc.signalingState === 'stable' && pc.currentLocalDescription)) {
                 try {
                    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                    console.log("VideoCallView: Caller (isCallerRef.current): Remote description (answer) set.");
                    setIsConnecting(false); 
                } catch (e: any) {
                    console.error("VideoCallView: Caller (isCallerRef.current): Error setting remote description (answer):", e.message, "Signaling state:", pc.signalingState);
                }
            } else {
                 console.warn("VideoCallView: Caller (isCallerRef.current): Received answer but PC not in 'have-local-offer' or 'stable with local desc' state. State:", pc.signalingState);
            }
          }

          if (data?.status && ['ended', 'ended_by_caller', 'ended_by_callee'].includes(data.status)) {
            const remotelyEndedByOther = (isCallerRef.current === false && data.status === 'ended_by_caller') || (isCallerRef.current === true && data.status === 'ended_by_callee');
            if ((remotelyEndedByOther || data.status === 'ended') && !localUserInitiatedEndRef.current) {
                console.log("VideoCallView: Call ended by other party or globally. Status:", data.status);
                if (data.status !== 'ended') { 
                  toast({title: "Call Ended", description: "The other user has ended the call."});
                }
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
      if (!localUserInitiatedEndRef.current) { 
        cleanupCall(false); // Call cleanup if unmount wasn't locally initiated
      }
    };
  }, [callId, localUser?.uid, isAudioOnly, onEndCall, toast, cleanupCall]);

  const handleLocalEndCall = async () => {
    console.log("VideoCallView: User clicked end call button for callId:", callId);
    localUserInitiatedEndRef.current = true; 

    if (callId && localUser && peerConnectionRef.current) {
        const callDocRef = doc(firestore, 'calls', callId);
        try {
            const callDocSnap = await getDoc(callDocRef);
            if (callDocSnap.exists()) {
                const callData = callDocSnap.data();
                let newStatus = callData.status;
                
                if (isCallerRef.current === true && callData.status !== 'ended_by_caller' && callData.status !== 'ended') {
                    newStatus = 'ended_by_caller';
                } else if (isCallerRef.current === false && callData.status !== 'ended_by_callee' && callData.status !== 'ended') {
                    newStatus = 'ended_by_callee';
                }

                const otherPartyAlreadyEnded = (isCallerRef.current === true && callData.status === 'ended_by_callee') ||
                                               (isCallerRef.current === false && callData.status === 'ended_by_caller');
                
                if (callData.status !== newStatus && !otherPartyAlreadyEnded && newStatus !== 'ended') {
                    await updateDoc(callDocRef, { status: newStatus, endedAt: serverTimestamp() });
                    console.log("VideoCallView: Updated call status to", newStatus, "for callId:", callId);
                } else if (otherPartyAlreadyEnded || newStatus === 'ended') {
                    console.log("VideoCallView: Call already ended by other party or in generic 'ended' state. Preparing for full cleanup by local action.");
                }
            }
        } catch (error) {
            console.error("VideoCallView: Error updating call status on end:", error);
        }
    }
    await cleanupCall(true); 
    onEndCall(); 
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
  
  if (hasMediaPermission === null && isConnecting) { 
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
                        {(isCallerRef.current !== null && peerConnectionRef.current?.connectionState !== 'connected') && <p className="text-xs mt-1">Waiting for other user to connect.</p>}
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
                  <p> {isCallerRef.current === null ? "Initializing..." : (isCallerRef.current ? `Calling (${isAudioOnly ? 'Audio' : 'Video'})...` : `Attempting to join (${isAudioOnly ? 'Audio' : 'Video'})...`)} </p>
                  {(isCallerRef.current !== null && peerConnectionRef.current?.connectionState !== 'connected') && <p className="text-xs mt-1">Waiting for other user to connect.</p>}
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
