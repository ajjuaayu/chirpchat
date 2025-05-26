
"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Mic, MicOff, PhoneOff, Video, VideoOff, Loader2, User as UserIcon, AlertTriangle } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { User as AuthUser, CallType, CallStatus } from "@/types";
import { 
  doc, 
  onSnapshot, 
  setDoc, 
  updateDoc, 
  collection, 
  addDoc, 
  getDoc, 
  deleteDoc, 
  serverTimestamp, 
  query, 
  getDocs, 
  writeBatch, 
  Unsubscribe, 
  DocumentSnapshot,
  DocumentData,
  Timestamp
} from "firebase/firestore";
import { firestore } from "@/lib/firebase";

interface VideoCallViewProps {
  callId: string;
  onEndCall: (duration?: number) => void; // Duration in seconds
  localUser: AuthUser;
  isAudioOnly: boolean;
  logCallEventToChat: (callId: string, type: CallType, status: CallStatus, duration?: number) => Promise<void>;
}

const stunServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function VideoCallView({ callId, onEndCall, localUser, isAudioOnly, logCallEventToChat }: VideoCallViewProps) {
  const { toast } = useToast();

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(isAudioOnly);
  const [hasMediaPermission, setHasMediaPermission] = useState<boolean | null>(null);
  const [isConnecting, setIsConnecting] = useState(true);
  
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  
  const callDocUnsubscribeRef = useRef<Unsubscribe | null>(null);
  const callerCandidatesUnsubscribeRef = useRef<Unsubscribe | null>(null);
  const calleeCandidatesUnsubscribeRef = useRef<Unsubscribe | null>(null);

  const localUserInitiatedEndRef = useRef(false); // True if local user clicked "End Call"
  const isCallerRef = useRef<boolean | null>(null); 
  const callStartTimeRef = useRef<Date | null>(null);


  const cleanupCall = useCallback(async (initiatedByLocalUser = false, skipFirestoreDeletion = false) => {
    console.log(`VideoCallView: cleanupCall triggered for callId: ${callId}. Local initiated: ${initiatedByLocalUser}, Skip Firestore Deletion: ${skipFirestoreDeletion}`);
    localUserInitiatedEndRef.current = initiatedByLocalUser;

    let durationSeconds: number | undefined = undefined;
    if (callStartTimeRef.current) {
        durationSeconds = Math.round((new Date().getTime() - callStartTimeRef.current.getTime()) / 1000);
        callStartTimeRef.current = null; // Reset for next call
    }


    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log(`VideoCallView: Stopped local media track: ${track.kind}`);
      });
      localStreamRef.current = null;
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    remoteStreamRef.current = null;

    if (peerConnectionRef.current) {
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.onconnectionstatechange = null;
      peerConnectionRef.current.onsignalingstatechange = null;
      peerConnectionRef.current.oniceconnectionstatechange = null;
      if (peerConnectionRef.current.signalingState !== 'closed') {
        peerConnectionRef.current.close();
      }
      peerConnectionRef.current = null;
      console.log("VideoCallView: Peer connection closed and event handlers cleared for callId:", callId);
    }

    if (callDocUnsubscribeRef.current) { callDocUnsubscribeRef.current(); callDocUnsubscribeRef.current = null; console.log("VideoCallView: Unsubscribed from call document for callId:", callId); }
    if (callerCandidatesUnsubscribeRef.current) { callerCandidatesUnsubscribeRef.current(); callerCandidatesUnsubscribeRef.current = null; console.log("VideoCallView: Unsubscribed from caller candidates for callId:", callId); }
    if (calleeCandidatesUnsubscribeRef.current) { calleeCandidatesUnsubscribeRef.current(); calleeCandidatesUnsubscribeRef.current = null; console.log("VideoCallView: Unsubscribed from callee candidates for callId:", callId); }
    
    isCallerRef.current = null;

    if (initiatedByLocalUser && callId && localUser.uid && !skipFirestoreDeletion) {
      const callDocRef = doc(firestore, 'calls', callId);
      try {
        const callDocSnap = await getDoc(callDocRef);
        if (callDocSnap.exists()) {
          const callData = callDocSnap.data();
          const userIsCurrentlyCaller = callData.callerId === localUser.uid;
          const userIsCurrentlyCallee = callData.calleeId === localUser.uid;
          
          let shouldUpdateFirestore = false;
          let updatePayload: DocumentData = { endedAt: serverTimestamp() };

          if (userIsCurrentlyCaller && callData.status !== 'ended_by_caller' && callData.status !== 'ended') {
            shouldUpdateFirestore = true;
            updatePayload.status = 'ended_by_caller';
            console.log("VideoCallView: Caller ending call. Preparing to update Firestore status to ended_by_caller for callId:", callId);
          } else if (userIsCurrentlyCallee && callData.status !== 'ended_by_callee' && callData.status !== 'ended') {
            shouldUpdateFirestore = true;
            updatePayload.status = 'ended_by_callee';
            console.log("VideoCallView: Callee ending call. Preparing to update Firestore status to ended_by_callee for callId:", callId);
          }

          if (shouldUpdateFirestore) {
            await updateDoc(callDocRef, updatePayload);
            console.log("VideoCallView: Firestore status updated for callId:", callId, updatePayload);
          }
          
          const updatedCallDocSnap = await getDoc(callDocRef); 
          if (updatedCallDocSnap.exists()) {
            const updatedCallData = updatedCallDocSnap.data();
            const otherPartyEnded = (userIsCurrentlyCaller && updatedCallData.status === 'ended_by_callee') ||
                                    (userIsCurrentlyCallee && updatedCallData.status === 'ended_by_caller') ||
                                    updatedCallData.status === 'ended';
            const selfEndedAndNoOtherParty = (userIsCurrentlyCaller && updatedCallData.status === 'ended_by_caller' && !updatedCallData.calleeId);

            if (otherPartyEnded || selfEndedAndNoOtherParty || updatedCallData.status === 'ended') {
              console.log("VideoCallView: Conditions met for deleting call document and subcollections for callId:", callId);
              const batch = writeBatch(firestore);
              const callerCandidatesQuery = query(collection(firestore, `calls/${callId}/callerCandidates`));
              const callerCandidatesSnap = await getDocs(callerCandidatesQuery);
              callerCandidatesSnap.forEach(docSn => batch.delete(docSn.ref));
              
              const calleeCandidatesQuery = query(collection(firestore, `calls/${callId}/calleeCandidates`));
              const calleeCandidatesSnap = await getDocs(calleeCandidatesQuery);
              calleeCandidatesSnap.forEach(docSn => batch.delete(docSn.ref));
              
              batch.delete(callDocRef);
              await batch.commit();
              console.log("VideoCallView: Call document and subcollections deleted by local user for callId:", callId);
            }
          }
        }
      } catch (error) {
        console.error("VideoCallView: Error during Firestore cleanup in cleanupCall for callId:", callId, error);
      }
    }
    console.log("VideoCallView: cleanupCall finished for callId:", callId);
    return durationSeconds;
  }, [callId, localUser.uid, toast]);

  const initializeCall = useCallback(async () => {
    console.log(`VideoCallView: initializeCall started. callId: ${callId}, localUser: ${localUser.uid}, isAudioOnly: ${isAudioOnly}`);
    localUserInitiatedEndRef.current = false;
    setIsConnecting(true);
    
    if (!localStreamRef.current && hasMediaPermission !== true) {
      try {
        console.log("VideoCallView: Requesting media devices with constraints:", { video: !isAudioOnly, audio: true });
        const stream = await navigator.mediaDevices.getUserMedia({ video: !isAudioOnly, audio: true });
        console.log("VideoCallView: Media devices acquired successfully for callId:", callId);
        
        if (isAudioOnly) {
          stream.getVideoTracks().forEach(track => { track.enabled = false; });
          setIsCameraOff(true); 
        } else {
          stream.getVideoTracks().forEach(track => track.enabled = !isCameraOff);
        }
        stream.getAudioTracks().forEach(track => track.enabled = !isMuted);

        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        setHasMediaPermission(true);
      } catch (error: any) {
        console.error('VideoCallView: Error getting media permissions for callId:', callId, error);
        setHasMediaPermission(false);
        let title = 'Media Access Error';
        let description = `Could not start ${isAudioOnly ? 'audio' : 'video'} call for callId: ${callId}.`;
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
          description = 'Camera and/or microphone access was denied. Please enable it in your browser settings.';
        } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
          description = 'No camera or microphone found. Please ensure they are connected and enabled.';
        } else {
           description = error.message || 'An unexpected error occurred while accessing media devices.';
        }
        toast({ variant: 'destructive', title, description, duration: 7000 });
        if (!localUserInitiatedEndRef.current) onEndCall(); 
        return; 
      }
    } else if (localStreamRef.current && hasMediaPermission === true) {
      console.log("VideoCallView: Local stream already exists. Ensuring track states match UI for callId:", callId)
      if (isAudioOnly) {
        localStreamRef.current.getVideoTracks().forEach(track => track.enabled = false);
        if (!isCameraOff) setIsCameraOff(true); 
      } else {
        localStreamRef.current.getVideoTracks().forEach(track => track.enabled = !isCameraOff);
      }
      localStreamRef.current.getAudioTracks().forEach(track => track.enabled = !isMuted);
      if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current; 
    }

    if (hasMediaPermission === false) {
        console.warn("VideoCallView: Media permission denied, cannot proceed with call setup for callId:", callId);
        if (!localUserInitiatedEndRef.current) onEndCall();
        return;
    }
    if (!localStreamRef.current) {
        console.error("VideoCallView: Local stream not available after permission check for callId:", callId);
        toast({ variant: 'destructive', title: 'Media Error', description: 'Local media stream could not be established.' });
        if (!localUserInitiatedEndRef.current) onEndCall();
        return;
    }

    const pc = new RTCPeerConnection(stunServers);
    peerConnectionRef.current = pc;
    console.log("VideoCallView: RTCPeerConnection created for callId:", callId, "Initial Signalling State:", pc.signalingState);

    localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current!));

    pc.onicecandidate = event => {
      if (event.candidate && callId && isCallerRef.current !== null) {
        const candidatesCollectionPath = isCallerRef.current ? `calls/${callId}/callerCandidates` : `calls/${callId}/calleeCandidates`;
        console.log(`VideoCallView: Sending ICE candidate to ${candidatesCollectionPath} for callId:`, callId, event.candidate);
        addDoc(collection(firestore, candidatesCollectionPath), event.candidate.toJSON())
          .catch(e => console.error("VideoCallView: Error adding ICE candidate to Firestore for callId:", callId, e));
      }
    };

    pc.ontrack = event => {
      console.log("VideoCallView: ontrack event for callId:", callId, "Streams:", event.streams);
      if (event.streams && event.streams[0]) {
        remoteStreamRef.current = event.streams[0];
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = event.streams[0];
        console.log("VideoCallView: Remote stream attached for callId:", callId);
        setIsConnecting(false);
        if(!callStartTimeRef.current) callStartTimeRef.current = new Date(); // Start timer when remote stream arrives
      } else {
        console.warn("VideoCallView: ontrack event received but no stream/track found for callId:", callId);
      }
    };
    
    pc.onconnectionstatechange = () => {
      console.log("VideoCallView: Peer connection state changed to:", pc.connectionState, "for callId:", callId);
      if (pc.connectionState === 'connected') {
        setIsConnecting(false);
        if(!callStartTimeRef.current) callStartTimeRef.current = new Date(); 
      } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
         console.warn("VideoCallView: Peer connection state is disconnected, failed, or closed:", pc.connectionState, "for callId:", callId);
         if (!localUserInitiatedEndRef.current) {
           toast({ title: "Call Disconnected", description: `Connection state: ${pc.connectionState}`, variant: "destructive" });
           onEndCall(); 
         }
      }
    };

    pc.onsignalingstatechange = () => console.log("VideoCallView: Peer signaling state changed to:", pc.signalingState, "for callId:", callId, "LocalDesc:", pc.currentLocalDescription!=null, "RemoteDesc:", pc.currentRemoteDescription!=null);
    
    pc.oniceconnectionstatechange = () => {
        console.log("VideoCallView: Peer ICE connection state changed to:", pc.iceConnectionState, "for callId:", callId);
         if (pc.iceConnectionState === 'failed' && !localUserInitiatedEndRef.current) {
            console.error("VideoCallView: ICE connection failed for callId:", callId);
            toast({variant: "destructive", title: "Connection Problem", description: "Could not establish a stable peer connection."});
            onEndCall();
        }
    };

    const callDocRef = doc(firestore, 'calls', callId);
    try {
      let callDocSnap = await getDoc(callDocRef);
      let callData = callDocSnap.exists() ? callDocSnap.data() as DocumentData : null;
      console.log("VideoCallView: Fetched call document for callId:", callId, "Exists:", callDocSnap.exists(), "Data:", callData);

      // Scenario 1: User is initiating a new call (caller)
      if (!callDocSnap.exists() || (callData && ['ended', 'ended_by_caller', 'ended_by_callee'].includes(callData.status))) {
        isCallerRef.current = true;
        console.log("VideoCallView (Caller): New call or reusing ended slot for callId:", callId);

        if (callDocSnap.exists()) { 
            console.log("VideoCallView (Caller): Found stale/ended call document. Deleting before creating new one for callId:", callId);
            const batch = writeBatch(firestore);
            const oldCallerCandidates = await getDocs(query(collection(firestore, `calls/${callId}/callerCandidates`)));
            oldCallerCandidates.forEach((d) => batch.delete(d.ref));
            const oldCalleeCandidates = await getDocs(query(collection(firestore, `calls/${callId}/calleeCandidates`)));
            oldCalleeCandidates.forEach((d) => batch.delete(d.ref));
            batch.delete(callDocRef);
            await batch.commit();
            console.log("VideoCallView (Caller): Stale call document and candidates deleted for callId:", callId);
        }
        
        console.log("VideoCallView (Caller): Creating offer for callId:", callId, "Signaling State:", pc.signalingState);
        const offerDescription = await pc.createOffer();
        
        console.log("VideoCallView (Caller): Setting local description (offer) for callId:", callId, "Signaling State:", pc.signalingState);
        if (!pc.currentLocalDescription) {
            try {
                await pc.setLocalDescription(offerDescription);
            } catch (e) {
                 console.error("VideoCallView (Caller): Error setting local description (offer) for callId:", callId, e, "Signaling State:", pc.signalingState);
                 toast({ variant: "destructive", title: "Call Setup Error", description: `Failed to set local offer. ${e}` });
                 onEndCall(); return;
            }
        } else {
             console.warn("VideoCallView (Caller): Local description (offer) already set for callId:", callId);
        }

        const callDataForCreate = {
          callerId: localUser.uid,
          callerName: localUser.displayName || "Anonymous",
          offer: { type: offerDescription.type, sdp: offerDescription.sdp },
          status: 'ringing' as CallStatus,
          createdAt: serverTimestamp() as Timestamp,
          calleeId: null,
          calleeName: null,
          isAudioOnly: isAudioOnly,
        };
        await setDoc(callDocRef, callDataForCreate);
        console.log("VideoCallView (Caller): Call document created with offer for callId:", callId);

      // Scenario 2: User is rejoining as the original caller
      } else if (callData && callData.callerId === localUser.uid) {
        isCallerRef.current = true;
        console.log("VideoCallView (Rejoining Caller): User is original Caller for callId:", callId, "PC State:", pc.signalingState, "LocalDesc:", !!pc.currentLocalDescription, "RemoteDesc:", !!pc.currentRemoteDescription);

        if (callData.isAudioOnly !== isAudioOnly) {
          toast({variant: "destructive", title: "Call Type Mismatch", description: `This call is ${callData.isAudioOnly ? 'audio-only' : 'video'}. You tried to join with a different type.`});
          onEndCall(); return;
        }

        // If there's an answer, the caller's PC needs to set it as remote.
        if (callData.answer && !pc.currentRemoteDescription) {
          console.log("VideoCallView (Rejoining Caller): Answer exists. Setting remote description (answer from Firestore) for callId:", callId);
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(callData.answer));
            setIsConnecting(false); // Should be connected or connecting now
          } catch (e) {
            console.error("VideoCallView (Rejoining Caller): Error setting remote description (answer) for callId:", callId, e, "Signaling State:", pc.signalingState);
            toast({ variant: "destructive", title: "Call Setup Error", description: `Failed to set remote answer. ${e}` });
            onEndCall(); return;
          }
        } 
        // If only an offer exists (caller rejoined before callee answered), re-initiate offer for this PC instance.
        else if (callData.offer && !callData.answer && (!pc.currentLocalDescription || pc.currentLocalDescription.sdp !== callData.offer.sdp)) {
          console.log("VideoCallView (Rejoining Caller): Offer exists, no answer. Re-initiating offer process for this PC instance for callId:", callId);
          try {
            const newOfferDescription = await pc.createOffer();
            if (!pc.currentLocalDescription || pc.currentLocalDescription.type !== newOfferDescription.type) {
                await pc.setLocalDescription(newOfferDescription);
            }
            await updateDoc(callDocRef, { 
              offer: { type: newOfferDescription.type, sdp: newOfferDescription.sdp },
            });
            console.log("VideoCallView (Rejoining Caller): Firestore updated with new offer for callId:", callId);
          } catch (e: any) {
              console.error("VideoCallView (Rejoining Caller): Error re-initiating offer for callId:", callId, e, "Signaling state:", pc.signalingState);
              toast({ variant: "destructive", title: "Call Setup Error", description: `Failed to re-initiate offer. ${e.message}` });
              onEndCall(); return;
          }
        } else {
          console.log("VideoCallView (Rejoining Caller): Conditions for setting descriptions not met or already set for callId:", callId, "Offer:", !!callData.offer, "Answer:", !!callData.answer, "CurrentLocal:", !!pc.currentLocalDescription, "CurrentRemote:", !!pc.currentRemoteDescription, "SignalingState:", pc.signalingState);
          if (pc.currentLocalDescription && pc.currentRemoteDescription) setIsConnecting(false);
        }

      // Scenario 3: User is joining as callee (call was initiated by someone else)
      // This flow is now primarily driven by ChatWindow after user clicks "Accept".
      // VideoCallView for callee mounts AFTER ChatWindow updates the call doc with calleeId and status 'active'.
      } else if (callData && callData.status === 'active' && callData.calleeId === localUser.uid) {
        isCallerRef.current = false;
        console.log("VideoCallView (Callee): Joining active call as Callee for callId:", callId);
        
        if (callData.isAudioOnly !== isAudioOnly) {
          toast({variant: "destructive", title: "Call Type Mismatch", description: `This call is ${callData.isAudioOnly ? 'audio-only' : 'video'}.`});
          onEndCall(); return;
        }

        if (!callData.offer) {
            console.error("VideoCallView (Callee): Active call has no offer data for callId:", callId);
            toast({ variant: "destructive", title: "Call Error", description: "Call is active but no offer found." });
            onEndCall(); return;
        }

        // Callee sets the offer as remote description
        if (!pc.currentRemoteDescription) {
            console.log("VideoCallView (Callee): Setting remote description (offer) for callId:", callId, "Signaling State:", pc.signalingState);
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));
            } catch (e) {
                console.error("VideoCallView (Callee): Error setting remote description (offer) for callId:", callId, e, "Signaling State:", pc.signalingState);
                toast({ variant: "destructive", title: "Call Setup Error", description: `Failed to set remote offer. ${e}` });
                onEndCall(); return;
            }
        }
        
        // Callee creates and sets answer as local description
        // The answer should have already been created and set in Firestore by ChatWindow's handleAcceptCall.
        // Here we just set it as local description if not already set.
        if (callData.answer && !pc.currentLocalDescription) {
            console.log("VideoCallView (Callee): Setting local description (answer from Firestore) for callId:", callId, "Signaling State:", pc.signalingState);
             if (pc.signalingState === 'have-remote-offer' || pc.signalingState === 'stable') { // ensure pc is ready for local answer
                try {
                    await pc.setLocalDescription(new RTCSessionDescription(callData.answer));
                } catch (e) {
                    console.error("VideoCallView (Callee): Error setting local description (answer) for callId:", callId, e, "Signaling State:", pc.signalingState);
                    toast({ variant: "destructive", title: "Call Setup Error", description: `Failed to set local answer. ${e}` });
                    onEndCall(); return;
                }
            } else {
                 console.warn("VideoCallView (Callee): Cannot set local desc (answer), PC in state:", pc.signalingState, "for callId:", callId);
            }
        }
        if (pc.currentLocalDescription && pc.currentRemoteDescription) setIsConnecting(false);


      // Scenario 4: Call is busy or user is not part of it.
      } else if (callData && callData.status === 'active' && callData.callerId !== localUser.uid && callData.calleeId !== localUser.uid) {
        console.warn("VideoCallView: Call is busy with other participants for callId:", callId);
        toast({variant: "destructive", title: "Call Busy", description: "This call is already in progress with other users."});
        onEndCall(); return;
      } else {
        console.warn("VideoCallView: Call document in unexpected state or user not part of active call for callId:", callId, "User:", localUser.uid, "Call Data:", callData);
        toast({variant: "destructive", title: "Call Error", description: "Could not join the call due to an unexpected state."});
        onEndCall(); return;
      }


      // Firestore listeners for signaling
      callDocUnsubscribeRef.current = onSnapshot(callDocRef, (snapshot: DocumentSnapshot<DocumentData>) => {
        const currentData = snapshot.data() as DocumentData | undefined;
        console.log("VideoCallView (CallDoc Listener): Update for callId:", callId, "Data:", currentData, "PC Signaling State:", pc?.signalingState, "isCallerRef.current:", isCallerRef.current);
        
        if (!snapshot.exists()) {
          console.log("VideoCallView (CallDoc Listener): Call document deleted remotely for callId:", callId);
          if (!localUserInitiatedEndRef.current) {
            toast({title: "Call Ended", description: "The call was disconnected."});
            onEndCall();
          }
          return;
        }

        if (isCallerRef.current === true) { 
          if (currentData?.answer && pc && !pc.currentRemoteDescription) {
            if (pc.signalingState === 'have-local-offer' || pc.signalingState === 'stable') {
              console.log("VideoCallView (CallDoc Listener - Caller): Received answer. Setting remote description for callId:", callId, currentData.answer);
              pc.setRemoteDescription(new RTCSessionDescription(currentData.answer))
                .then(() => {
                    console.log("VideoCallView (CallDoc Listener - Caller): Remote description (answer) set for callId:", callId, "PC State:", pc.signalingState);
                    setIsConnecting(false);
                    if(!callStartTimeRef.current) callStartTimeRef.current = new Date();
                })
                .catch(e => console.error("VideoCallView (CallDoc Listener - Caller): Error setting remote description (answer) for callId:", callId, e, "Signaling State:", pc.signalingState));
            } else {
              console.warn("VideoCallView (CallDoc Listener - Caller): Received answer, but PC not in have-local-offer or stable state. State:", pc.signalingState, "for callId:", callId);
            }
          }
          if (currentData?.status && ['ended', 'ended_by_callee'].includes(currentData.status) && !localUserInitiatedEndRef.current) {
            console.log("VideoCallView (CallDoc Listener - Caller): Call ended by callee or globally for callId:", callId, "Status:", currentData.status);
            toast({title: "Call Ended", description: "The other user has ended the call."});
            onEndCall();
          }
        } else if (isCallerRef.current === false) { 
           if (currentData?.status && ['ended', 'ended_by_caller'].includes(currentData.status) && !localUserInitiatedEndRef.current) {
              console.log("VideoCallView (CallDoc Listener - Callee): Call ended by caller or globally for callId:", callId, "Status:", currentData.status);
              toast({title: "Call Ended", description: "The other user has ended the call."});
              onEndCall();
           }
        }
      });

      const candidatesCollectionPath = isCallerRef.current ? `calls/${callId}/calleeCandidates` : `calls/${callId}/callerCandidates`;
      const candidatesUnsubscribeTargetRef = isCallerRef.current ? calleeCandidatesUnsubscribeRef : callerCandidatesUnsubscribeRef;
      
      console.log("VideoCallView: Listening for ICE candidates on path:", candidatesCollectionPath, "for callId:", callId);
      candidatesUnsubscribeTargetRef.current = onSnapshot(collection(firestore, candidatesCollectionPath), snapshot => {
        snapshot.docChanges().forEach(async change => {
          if (change.type === 'added') {
            const candidate = change.doc.data();
            console.log("VideoCallView: Received remote ICE candidate for callId:", callId, candidate, "PC State:", pc?.signalingState, "RemoteDesc:", !!pc?.currentRemoteDescription);
            if (pc && (pc.remoteDescription || pc.currentRemoteDescription)) { 
               try { 
                 await pc.addIceCandidate(new RTCIceCandidate(candidate));
                 console.log("VideoCallView: Added remote ICE candidate successfully for callId:", callId);
               }
               catch (e) { console.error("VideoCallView: Error adding received ICE candidate for callId:", callId, e); }
            } else {
              console.warn("VideoCallView: Received ICE candidate but remote description not set yet or PC not available for callId:", callId, "Candidate ignored or queued by browser.");
            }
          }
        });
      });

    } catch (error: any) {
      console.error('VideoCallView: Error during main call setup (Firestore interaction or PC setup) for callId:', callId, error);
      toast({ variant: 'destructive', title: 'Call Setup Error', description: `Failed to set up the call. ${error.message || 'Please try again.'}`, duration: 7000 });
      if (!localUserInitiatedEndRef.current) onEndCall();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, localUser.uid, localUser.displayName, isAudioOnly, onEndCall, toast, hasMediaPermission, isCameraOff, isMuted]); // Removed cleanupCall from deps as it causes loops

  useEffect(() => {
    console.log("VideoCallView: useEffect triggered. callId:", callId, "localUser:", localUser?.uid);
    if (localUser?.uid && callId) { 
        initializeCall();
    } else {
        console.error("VideoCallView: Local user or callId not available, cannot initialize call. localUser:", localUser?.uid, "callId:", callId);
        if (!localUserInitiatedEndRef.current) onEndCall();
    }

    return () => {
      console.log("VideoCallView: useEffect cleanup for callId:", callId, "Local initiated end:", localUserInitiatedEndRef.current);
      let durationOnUnmount: number | undefined;
      if (!localUserInitiatedEndRef.current) { 
        durationOnUnmount = cleanupCall(false).then(duration => duration).catch(() => undefined);
      }
      // onEndCall might be called inside cleanupCall or here if needed after cleanup
      // This ensures onEndCall is eventually called if the component unmounts unexpectedly
      if (typeof durationOnUnmount === 'number' || durationOnUnmount === undefined) {
           // Ensure onEndCall is called from the main effect cleanup
           // only if not initiated by local user action (which calls onEndCall itself).
           if (!localUserInitiatedEndRef.current) {
             Promise.resolve(durationOnUnmount).then(finalDuration => onEndCall(finalDuration));
           }
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps 
  }, [callId, localUser?.uid, initializeCall]); // Removed onEndCall, cleanupCall from here if they cause loops


  const handleLocalEndCall = useCallback(async () => {
    console.log("VideoCallView: User clicked end call button for callId:", callId);
    localUserInitiatedEndRef.current = true; // Mark that this user ended the call
    const duration = await cleanupCall(true); 
    onEndCall(duration); 
  }, [cleanupCall, onEndCall, callId]);


  const toggleMute = () => {
    setIsMuted(prev => {
      const newMutedState = !prev;
      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach(track => track.enabled = !newMutedState);
        console.log(`VideoCallView: Audio tracks ${!newMutedState ? 'enabled' : 'disabled'} for callId:`, callId);
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
            console.log(`VideoCallView: Video tracks ${!newCameraOffState ? 'enabled' : 'disabled'} for callId:`, callId);
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
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Media Access Required</AlertTitle>
          <AlertDescription>
            Calling requires camera and/or microphone access. 
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
            style={{ display: remoteStreamRef.current && hasMediaPermission && !isAudioOnly ? 'block' : 'none' }}
          />
          {(!remoteStreamRef.current || isAudioOnly) && hasMediaPermission && (
            <div className="flex flex-col items-center text-muted-foreground p-4 text-center">
              {isAudioOnly && remoteStreamRef.current && <UserIcon className="h-32 w-32 mb-4 opacity-60" />}
              {isAudioOnly && remoteStreamRef.current && <p className="text-lg font-medium">Connected (Audio)</p>}

              {isConnecting && (!remoteStreamRef.current || peerConnectionRef.current?.connectionState !== 'connected') ? (
                <>
                  <Loader2 className="h-12 w-12 animate-spin mb-2" />
                  <p> {isCallerRef.current === null ? "Initializing..." : (isCallerRef.current ? `Calling (${isAudioOnly ? 'Audio' : 'Video'})...` : `Joining (${isAudioOnly ? 'Audio' : 'Video'})...`)} </p>
                  {(isCallerRef.current !== null && peerConnectionRef.current?.connectionState !== 'connected') && <p className="text-xs mt-1">Waiting for other user to connect.</p>}
                </>
              ) : (
                 peerConnectionRef.current?.connectionState === 'closed' || peerConnectionRef.current?.connectionState === 'failed' ? (
                    <>
                        {isAudioOnly ? <UserIcon className="h-16 w-16 mb-2 opacity-50" /> : <VideoOff className="h-16 w-16 mb-2 opacity-50" />}
                        <p>Call has ended.</p>
                    </>
                 ) : (
                    <>
                        {isAudioOnly ? <UserIcon className="h-16 w-16 mb-2 opacity-50" /> : <VideoOff className="h-16 w-16 mb-2 opacity-50" />}
                        <p>Waiting for remote {isAudioOnly ? 'audio' : 'video'}...</p>
                        {isAudioOnly ? null : <p className="text-xs mt-1">If this persists, the other user might not have camera enabled or there's a connection issue.</p>}
                    </>
                 )
              )}
            </div>
          )}
           {hasMediaPermission && remoteStreamRef.current && !isAudioOnly && <p className="absolute bottom-4 left-4 bg-black/50 text-white px-2 py-1 rounded text-sm">Remote User</p>}
        </div>

        <div className="md:col-span-1 flex flex-col gap-4">
            <div className="bg-muted rounded-lg overflow-hidden aspect-video relative flex-shrink-0">
               <video 
                  ref={localVideoRef} 
                  className="w-full h-full object-cover" 
                  autoPlay 
                  muted 
                  playsInline
                  style={{ display: !isAudioOnly && localStreamRef.current && !isCameraOff && hasMediaPermission ? 'block' : 'none' }}
                />
              {(isAudioOnly || !localStreamRef.current || isCameraOff || !hasMediaPermission) && (
                 <div className="w-full h-full bg-muted flex flex-col items-center justify-center text-foreground/60 p-2">
                    {!hasMediaPermission && localStreamRef.current === null ? (
                        <AlertTriangle className="h-12 w-12 text-destructive/70" />
                    ) : (
                        isAudioOnly ? <UserIcon className="h-16 w-16 mb-2 opacity-80" /> : <VideoOff className="h-12 w-12 text-foreground/50" />
                    )}
                    {isAudioOnly && <p className="text-sm font-medium">Your Audio</p>}
                    {isAudioOnly && isMuted && <p className="text-xs">(Muted)</p>}
                    {!isAudioOnly && hasMediaPermission && isCameraOff && <p className="text-sm">Camera Off</p>}
                 </div>
              )}
             {hasMediaPermission && localStreamRef.current && <p className="absolute bottom-2 left-2 bg-black/50 text-white px-1.5 py-0.5 rounded text-xs">
                You {isMuted && "(Muted)"} {(!isAudioOnly && isCameraOff) && "(Cam Off)"}
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
