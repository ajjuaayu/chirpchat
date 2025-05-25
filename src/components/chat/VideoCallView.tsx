
"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Mic, MicOff, PhoneOff, Video, VideoOff, Loader2, User as UserIcon, AlertTriangle } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { User as AuthUser } from "@/types";
import { doc, onSnapshot, setDoc, updateDoc, collection, addDoc, getDoc, deleteDoc, serverTimestamp, query, getDocs, writeBatch, Unsubscribe, DocumentReference, DocumentSnapshot } from "firebase/firestore";
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

// Define specific call IDs for general chat
const GENERAL_CHAT_AUDIO_CALL_ID = "call_channel_general_chat_audio";
const GENERAL_CHAT_VIDEO_CALL_ID = "call_channel_general_chat_video";


export function VideoCallView({ callId, onEndCall, localUser, isAudioOnly }: VideoCallViewProps) {
  const { toast } = useToast();

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(isAudioOnly); // Initialize based on isAudioOnly
  const [hasMediaPermission, setHasMediaPermission] = useState<boolean | null>(null);
  const [isConnecting, setIsConnecting] = useState(true);
  const [isCaller, setIsCaller] = useState<boolean | null>(null); 
  
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  
  const iceCandidateListenersUnsubscribeRef = useRef<Unsubscribe[]>([]);
  const callDocUnsubscribeRef = useRef<Unsubscribe | null>(null);
  const localUserInitiatedEndRef = useRef(false); 

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
          // Determine if this user's action should lead to deletion.
          // If this user is caller and ends, or callee and ends, and other party also ended or isn't there.
          const shouldDelete = (isCaller === true && (callData.status === 'ended_by_caller' || callData.status === 'ended_by_callee' || !callData.calleeId)) ||
                               (isCaller === false && (callData.status === 'ended_by_callee' || callData.status === 'ended_by_caller'));

          if (shouldDelete || callData.status === 'ended') { // 'ended' is a generic clean state
            console.log("VideoCallView: Local user initiated end & conditions met for deletion. Deleting call document and subcollections for callId:", callId);
            const batch = writeBatch(firestore);
            const callerCandidatesQuery = query(collection(firestore, `calls/${callId}/callerCandidates`));
            const callerCandidatesSnap = await getDocs(callerCandidatesQuery);
            callerCandidatesSnap.forEach(doc => batch.delete(doc.ref));
            
            const calleeCandidatesQuery = query(collection(firestore, `calls/${callId}/calleeCandidates`));
            const calleeCandidatesSnap = await getDocs(calleeCandidatesQuery);
            calleeCandidatesSnap.forEach(doc => batch.delete(doc.ref));
            
            batch.delete(callDocRef);
            await batch.commit();
            console.log("VideoCallView: Call document and subcollections deleted by local user under callId:", callId);
          } else {
             console.log("VideoCallView: Call document status not 'ended' or conditions not met for deletion, status was:", callData.status, "isCaller:", isCaller);
          }
        }
      } catch (error) {
        console.error("VideoCallView: Error during Firestore cleanup in cleanupCall:", error);
      }
    }
    console.log("VideoCallView: cleanupCall finished for callId:", callId);
  }, [callId, localUser, isCaller]); 

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
          console.log("VideoCallView: onicecandidate. Candidate:", event?.candidate ? "Yes" : "No", "Current isCaller state (from React state):", isCaller);
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
             if (!localUserInitiatedEndRef.current) { 
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
        let localIsCallerDetermination: boolean; 

        if (!callDocSnap.exists() || (callDocSnap.exists() && ['ended', 'ended_by_caller', 'ended_by_callee'].includes(callDocSnap.data()?.status))) {
          if(callDocSnap.exists()){
            console.log("VideoCallView: Stale/ended call document found. Cleaning up before becoming caller.", callDocSnap.data());
            const batch = writeBatch(firestore);
            const oldCallerCandidates = await getDocs(query(collection(firestore, `calls/${callId}/callerCandidates`)));
            oldCallerCandidates.forEach((d) => batch.delete(d.ref));
            const oldCalleeCandidates = await getDocs(query(collection(firestore, `calls/${callId}/calleeCandidates`)));
            oldCalleeCandidates.forEach((d) => batch.delete(d.ref));
            if (callDocSnap.exists()) batch.delete(callDocRef); // Check again if it exists before deleting
            await batch.commit();
            console.log("VideoCallView: Deleted stale call document and candidates for fixed call ID:", callId);
          }
          
          localIsCallerDetermination = true;
          setIsCaller(true); // Set React state
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
            setIsCaller(true);
            console.log("VideoCallView: Current user is original Caller, re-establishing. PC signaling state:", pcInstance.signalingState, "Local desc:", pcInstance.currentLocalDescription, "Remote desc:", pcInstance.currentRemoteDescription);
            
            if (callData.offer && !pcInstance.currentLocalDescription) {
                if (pcInstance.signalingState === 'stable') {
                    console.log("VideoCallView: Caller re-establishing: Setting local description (offer) from DB.");
                    await pcInstance.setLocalDescription(new RTCSessionDescription(callData.offer));
                } else {
                    console.warn("VideoCallView: Caller re-establishing: Cannot set local offer, PC not in 'stable' state. State:", pcInstance.signalingState);
                }
            } else if (callData.offer && pcInstance.currentLocalDescription && pcInstance.currentLocalDescription.type !== 'offer') {
                console.warn("VideoCallView: Caller re-establishing: Local description exists but is not an offer. This is unexpected.", pcInstance.currentLocalDescription);
            }
            
            if (callData.answer && !pcInstance.currentRemoteDescription) {
                if (pcInstance.signalingState === 'have-local-offer' || (pcInstance.signalingState === 'stable' && pcInstance.currentLocalDescription)) {
                    console.log("VideoCallView: Caller re-establishing: Setting remote description (answer) from DB.");
                    await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.answer));
                } else {
                     console.warn("VideoCallView: Caller re-establishing: Cannot set remote answer, PC not in 'have-local-offer' or 'stable with local desc' state. State:", pcInstance.signalingState);
                }
            }
            if (pcInstance.currentRemoteDescription && pcInstance.currentLocalDescription) setIsConnecting(false);


          } else if (callData.status === 'ringing' && !callData.calleeId) { 
            localIsCallerDetermination = false;
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
            setIsCaller(false); 
            console.log("VideoCallView: Callee rejoining active call. PC signaling state:", pcInstance.signalingState, "Local desc:", pcInstance.currentLocalDescription, "Remote desc:", pcInstance.currentRemoteDescription);
             
            if (callData.offer && !pcInstance.currentRemoteDescription) {
                if (pcInstance.signalingState === 'stable') {
                    console.log("VideoCallView: Callee rejoining: Setting remote description (offer) from DB.");
                    await pcInstance.setRemoteDescription(new RTCSessionDescription(callData.offer));
                } else {
                    console.warn("VideoCallView: Callee rejoining: Cannot set remote offer, PC not in 'stable' state. State:", pcInstance.signalingState);
                }
            } else if (callData.offer && pcInstance.currentRemoteDescription && pcInstance.currentRemoteDescription.type !== 'offer') {
                 console.warn("VideoCallView: Callee rejoining: Remote description exists but is not an offer. This is unexpected.", pcInstance.currentRemoteDescription);
            }
            
            if (callData.answer && !pcInstance.currentLocalDescription) {
                if (pcInstance.signalingState === 'have-remote-offer') {
                     console.log("VideoCallView: Callee rejoining: Setting local description (answer) from DB.");
                    await pcInstance.setLocalDescription(new RTCSessionDescription(callData.answer));
                } else {
                     console.warn("VideoCallView: Callee rejoining: Cannot set local answer, PC not in 'have-remote-offer' state. State:", pcInstance.signalingState);
                }
            } else if (callData.answer && pcInstance.currentLocalDescription && pcInstance.currentLocalDescription.type !== 'answer') {
                 console.warn("VideoCallView: Callee rejoining: Local description exists but is not an answer. This is unexpected.", pcInstance.currentLocalDescription);
            }
            if (pcInstance.currentRemoteDescription && pcInstance.currentLocalDescription) setIsConnecting(false);

          } else {
            console.warn("VideoCallView: Call document in unexpected state. User:", localUser.uid, "Call Data:", callData);
             const batch = writeBatch(firestore);
            const oldCallerCandidates = await getDocs(query(collection(firestore, `calls/${callId}/callerCandidates`)));
            oldCallerCandidates.forEach((d) => batch.delete(d.ref));
            const oldCalleeCandidates = await getDocs(query(collection(firestore, `calls/${callId}/calleeCandidates`)));
            oldCalleeCandidates.forEach((d) => batch.delete(d.ref));
            batch.delete(callDocRef); 
            await batch.commit();
            console.log("VideoCallView: Deleted unexpected state call document. Will attempt to become new caller.");

            // Attempt to become new caller
            localIsCallerDetermination = true;
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
        
        // Use localIsCallerDetermination for immediate decisions, React state 'isCaller' for subsequent renders/effects
        const currentRoleIsCaller = localIsCallerDetermination;
        setIsCaller(currentRoleIsCaller); // Set React state for future use

        const remoteCandidatesCollectionName = currentRoleIsCaller ? "calleeCandidates" : "callerCandidates";
        console.log(`VideoCallView: Setting up listener for remote ICE candidates from ${remoteCandidatesCollectionName}`);
        const unsubRemoteCandidates = onSnapshot(collection(firestore, `calls/${callId}/${remoteCandidatesCollectionName}`), snapshot => {
          snapshot.docChanges().forEach(async change => { 
            if (change.type === 'added') {
              const candidate = change.doc.data();
              console.log(`VideoCallView: Received remote ICE candidate from ${remoteCandidatesCollectionName}:`, candidate, "PC State:", peerConnectionRef.current?.signalingState);
              try {
                if (peerConnectionRef.current && peerConnectionRef.current.signalingState !== 'closed' && candidate) { 
                  // Ensure candidate is not null or undefined and PC is in a valid state
                  if (peerConnectionRef.current.remoteDescription || peerConnectionRef.current.currentRemoteDescription) { // Only add if remote description is set
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
        
        callDocUnsubscribeRef.current = onSnapshot(callDocRef, async (snapshot) => { 
          const data = snapshot.data();
          console.log("VideoCallView: Call document update. Exists:", snapshot.exists(), "Data:", data, "PC State:", peerConnectionRef.current?.signalingState, "Local isCaller (React state):", isCaller);

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

          // Use the React state `isCaller` here as this listener is long-lived
          if (isCaller === true && data?.answer && !pc.currentRemoteDescription) {
            console.log("VideoCallView: Caller (React state): Detected answer. Current PC signaling state:", pc.signalingState);
            if (pc.signalingState === 'have-local-offer' || (pc.signalingState === 'stable' && pc.currentLocalDescription)) {
                 try {
                    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                    console.log("VideoCallView: Caller (React state): Remote description (answer) set.");
                    setIsConnecting(false); 
                } catch (e) {
                    console.error("VideoCallView: Caller (React state): Error setting remote description (answer):", e);
                }
            } else {
                 console.warn("VideoCallView: Caller (React state): Received answer but PC not in 'have-local-offer' or 'stable with local desc' state. State:", pc.signalingState);
            }
          }

          if (data?.status && ['ended', 'ended_by_caller', 'ended_by_callee'].includes(data.status)) {
            const remotelyEnded = (isCaller === false && data.status === 'ended_by_caller') || (isCaller === true && data.status === 'ended_by_callee');
            if ((remotelyEnded || data.status === 'ended') && !localUserInitiatedEndRef.current) {
                console.log("VideoCallView: Call ended by other party or globally. Status:", data.status);
                if (data.status !== 'ended') { // Avoid double toast if it's a generic 'ended' from cleanup
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
        cleanupCall(false); 
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, localUser?.uid, isAudioOnly, onEndCall, toast]); // isCaller is intentionally omitted to avoid re-runs based on its async update initially

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
                
                if (isCaller === true && callData.status !== 'ended_by_caller' && callData.status !== 'ended') {
                    newStatus = 'ended_by_caller';
                } else if (isCaller === false && callData.status !== 'ended_by_callee' && callData.status !== 'ended') {
                    newStatus = 'ended_by_callee';
                }

                const otherPartyEnded = (isCaller === true && callData.status === 'ended_by_callee') ||
                                        (isCaller === false && callData.status === 'ended_by_caller');
                
                if (callData.status !== newStatus && !otherPartyEnded && newStatus !== 'ended') {
                    await updateDoc(callDocRef, { status: newStatus, endedAt: serverTimestamp() });
                    console.log("VideoCallView: Updated call status to", newStatus, "for callId:", callId);
                } else if (otherPartyEnded || newStatus === 'ended') {
                    console.log("VideoCallView: Call already ended by other party or in generic 'ended' state. Preparing for full cleanup.");
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

