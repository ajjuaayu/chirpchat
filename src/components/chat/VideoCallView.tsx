
"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Mic, MicOff, PhoneOff, Video, VideoOff, Loader2, User as UserIcon, AlertTriangle } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { User as AuthUser } from "@/types";
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
  DocumentData
} from "firebase/firestore";
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
  
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  
  const callDocUnsubscribeRef = useRef<Unsubscribe | null>(null);
  const callerCandidatesUnsubscribeRef = useRef<Unsubscribe | null>(null);
  const calleeCandidatesUnsubscribeRef = useRef<Unsubscribe | null>(null);

  const localUserInitiatedEndRef = useRef(false);
  const isCallerRef = useRef<boolean | null>(null);


  const cleanupCall = useCallback(async (initiatedByLocalUser = false, skipFirestoreDeletion = false) => {
    console.log(`VideoCallView: cleanupCall triggered. callId: ${callId}, Local initiated: ${initiatedByLocalUser}, Skip Firestore Deletion: ${skipFirestoreDeletion}`);
    localUserInitiatedEndRef.current = initiatedByLocalUser;

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
      console.log("VideoCallView: Local media tracks stopped.");
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
      console.log("VideoCallView: Peer connection closed.");
    }

    if (callDocUnsubscribeRef.current) { callDocUnsubscribeRef.current(); callDocUnsubscribeRef.current = null; console.log("VideoCallView: Unsubscribed from call document."); }
    if (callerCandidatesUnsubscribeRef.current) { callerCandidatesUnsubscribeRef.current(); callerCandidatesUnsubscribeRef.current = null; console.log("VideoCallView: Unsubscribed from caller candidates.");}
    if (calleeCandidatesUnsubscribeRef.current) { calleeCandidatesUnsubscribeRef.current(); calleeCandidatesUnsubscribeRef.current = null; console.log("VideoCallView: Unsubscribed from callee candidates.");}
    
    if (initiatedByLocalUser && callId && localUser.uid && !skipFirestoreDeletion) {
      const callDocRef = doc(firestore, 'calls', callId);
      try {
        const callDocSnap = await getDoc(callDocRef);
        if (callDocSnap.exists()) {
          const callData = callDocSnap.data();
          const userIsCurrentlyCaller = callData.callerId === localUser.uid;
          const userIsCurrentlyCallee = callData.calleeId === localUser.uid;
          let newStatus = callData.status;

          if (userIsCurrentlyCaller && callData.status !== 'ended_by_caller' && callData.status !== 'ended') {
            newStatus = 'ended_by_caller';
            await updateDoc(callDocRef, { status: newStatus, endedAt: serverTimestamp() });
            console.log("VideoCallView: Caller ended call, updated status in Firestore to ended_by_caller.");
          } else if (userIsCurrentlyCallee && callData.status !== 'ended_by_callee' && callData.status !== 'ended') {
            newStatus = 'ended_by_callee';
            await updateDoc(callDocRef, { status: newStatus, endedAt: serverTimestamp() });
            console.log("VideoCallView: Callee ended call, updated status in Firestore to ended_by_callee.");
          }
          
          const updatedCallData = (await getDoc(callDocRef)).data(); // Get fresh data
          if (updatedCallData) {
            const otherPartyEnded = (userIsCurrentlyCaller && updatedCallData.status === 'ended_by_callee') ||
                                    (userIsCurrentlyCallee && updatedCallData.status === 'ended_by_caller') ||
                                    updatedCallData.status === 'ended';
            const selfEndedAndNoOtherParty = (userIsCurrentlyCaller && updatedCallData.status === 'ended_by_caller' && !updatedCallData.calleeId); // Caller ends before anyone joins

            if (otherPartyEnded || selfEndedAndNoOtherParty) {
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
              console.log("VideoCallView: Call document and subcollections deleted by local user under callId:", callId);
            }
          }
        }
      } catch (error) {
        console.error("VideoCallView: Error during Firestore cleanup in cleanupCall:", error);
      }
    }
    console.log("VideoCallView: cleanupCall finished for callId:", callId);
  }, [callId, localUser.uid, toast]);

  const initializeCall = useCallback(async () => {
    console.log(`VideoCallView: initializeCall started. callId: ${callId}, isAudioOnly: ${isAudioOnly}`);
    localUserInitiatedEndRef.current = false;
    setIsConnecting(true);
    setHasMediaPermission(null);

    try {
      console.log("VideoCallView: Requesting media devices with constraints:", { video: !isAudioOnly, audio: true });
      const stream = await navigator.mediaDevices.getUserMedia({ video: !isAudioOnly, audio: true });
      console.log("VideoCallView: Media devices acquired successfully.");
      
      if (isAudioOnly) {
        stream.getVideoTracks().forEach(track => { track.enabled = false; track.stop(); });
        setIsCameraOff(true);
      } else {
        stream.getVideoTracks().forEach(track => track.enabled = !isCameraOff);
      }
      stream.getAudioTracks().forEach(track => track.enabled = !isMuted);

      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      setHasMediaPermission(true);

      const pc = new RTCPeerConnection(stunServers);
      peerConnectionRef.current = pc;
      console.log("VideoCallView: RTCPeerConnection created. Initial Signalling State:", pc.signalingState);

      localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current!));

      pc.onicecandidate = event => {
        if (event.candidate && callId && isCallerRef.current !== null) {
          const candidatesCollectionPath = isCallerRef.current ? `calls/${callId}/callerCandidates` : `calls/${callId}/calleeCandidates`;
          console.log(`VideoCallView: Sending ICE candidate to ${candidatesCollectionPath}`);
          addDoc(collection(firestore, candidatesCollectionPath), event.candidate.toJSON())
            .catch(e => console.error("VideoCallView: Error adding ICE candidate to Firestore:", e));
        }
      };

      pc.ontrack = event => {
        console.log("VideoCallView: ontrack event. Streams:", event.streams);
        if (event.streams && event.streams[0]) {
          remoteStreamRef.current = event.streams[0];
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = event.streams[0];
          setIsConnecting(false);
        }
      };
      
      pc.onconnectionstatechange = () => {
        console.log("VideoCallView: Peer connection state changed to:", pc.connectionState);
        if (pc.connectionState === 'connected') setIsConnecting(false);
        else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
           console.warn("VideoCallView: Peer connection state is disconnected, failed, or closed:", pc.connectionState);
           if (!localUserInitiatedEndRef.current) onEndCall(); 
        }
      };

      pc.onsignalingstatechange = () => console.log("VideoCallView: Peer signaling state changed to:", pc.signalingState);
      pc.oniceconnectionstatechange = () => {
          console.log("VideoCallView: Peer ICE connection state changed to:", pc.iceConnectionState);
           if (pc.iceConnectionState === 'failed' && !localUserInitiatedEndRef.current) {
              console.error("VideoCallView: ICE connection failed.");
              toast({variant: "destructive", title: "Connection Failed", description: "Could not establish a stable connection."});
              if (!localUserInitiatedEndRef.current) onEndCall();
          }
      };

      const callDocRef = doc(firestore, 'calls', callId);
      let callDocSnap = await getDoc(callDocRef);
      let callData = callDocSnap.exists() ? callDocSnap.data() : null;

      // Determine if this user is the caller or callee
      if (!callDocSnap.exists() || (callData && ['ended', 'ended_by_caller', 'ended_by_callee'].includes(callData.status))) {
        // This user is the caller (new call or taking over a previously ended call slot)
        isCallerRef.current = true;
        console.log("VideoCallView: User is Caller. Creating or re-creating call document.");

        if (callDocSnap.exists()) { // Clean up stale/ended document
            console.log("VideoCallView: Found stale/ended call document. Deleting before creating new one.");
            await cleanupCall(true, true); // Perform local cleanup & request Firestore deletion but skip its own Firestore update part
            const batch = writeBatch(firestore);
            const oldCallerCandidates = await getDocs(query(collection(firestore, `calls/${callId}/callerCandidates`)));
            oldCallerCandidates.forEach((d) => batch.delete(d.ref));
            const oldCalleeCandidates = await getDocs(query(collection(firestore, `calls/${callId}/calleeCandidates`)));
            oldCalleeCandidates.forEach((d) => batch.delete(d.ref));
            batch.delete(callDocRef);
            await batch.commit();
            console.log("VideoCallView: Stale call document and candidates deleted.");
            callDocSnap = await getDoc(callDocRef); // Re-fetch, should not exist now
            callData = null;
        }
        
        if (pc.signalingState !== 'stable') {
            console.error("VideoCallView (Caller): PC not stable for createOffer. State:", pc.signalingState);
            throw new Error("PeerConnection not stable for creating offer.");
        }
        const offerDescription = await pc.createOffer();
        await pc.setLocalDescription(offerDescription);
        console.log("VideoCallView (Caller): Local description (offer) set. PC State:", pc.signalingState);

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
        console.log("VideoCallView (Caller): Call document created with offer.");

      } else if (callData && callData.callerId === localUser.uid) { // Original caller rejoining
          isCallerRef.current = true;
          console.log("VideoCallView (Rejoining Caller): User is original Caller. PC State:", pc.signalingState, "LocalDesc:", pc.currentLocalDescription, "RemoteDesc:", pc.currentRemoteDescription);

          if (callData.answer) { // Answer exists, means call was established or callee responded
            if (!pc.currentRemoteDescription) {
              console.log("VideoCallView (Rejoining Caller): Answer exists. Setting remote description (answer from Firestore). Answer:", callData.answer);
              try {
                await pc.setRemoteDescription(new RTCSessionDescription(callData.answer));
                console.log("VideoCallView (Rejoining Caller): Remote description (answer) set. PC State:", pc.signalingState);
                setIsConnecting(false);
              } catch (e: any) {
                console.error("VideoCallView (Rejoining Caller): Error setting remote description (answer):", e.message, "Signaling state:", pc.signalingState);
                throw e; // Propagate error to main catch block
              }
            } else {
               console.log("VideoCallView (Rejoining Caller): Remote description (answer) already set.");
               setIsConnecting(false);
            }
          } else if (callData.offer && pc.signalingState === 'stable' && !pc.currentLocalDescription) { 
            // Offer exists, but no answer yet. Caller rejoining before callee answers.
            // The new PC instance should re-initiate the offer process *for itself*.
            console.log("VideoCallView (Rejoining Caller): Offer exists, no answer. Re-initiating offer process for this PC instance.");
            try {
              const offerDescription = await pc.createOffer();
              await pc.setLocalDescription(offerDescription); // Set the NEW offer as local
              console.log("VideoCallView (Rejoining Caller): New local description (re-offer) set. PC State:", pc.signalingState);
              
              await updateDoc(callDocRef, { 
                offer: { type: offerDescription.type, sdp: offerDescription.sdp },
                // status: 'ringing', // Ensure status is ringing
              });
              console.log("VideoCallView (Rejoining Caller): Firestore updated with new offer.");
            } catch (e: any) {
                console.error("VideoCallView (Rejoining Caller): Error re-initiating offer:", e.message, "Signaling state:", pc.signalingState);
                throw e; // Propagate error
            }
          } else {
            console.log("VideoCallView (Rejoining Caller): Conditions for setting descriptions not fully met or already set. Offer:", !!callData.offer, "Answer:", !!callData.answer, "CurrentLocal:", !!pc.currentLocalDescription, "CurrentRemote:", !!pc.currentRemoteDescription, "SignalingState:", pc.signalingState);
            if (pc.currentLocalDescription && pc.currentRemoteDescription) setIsConnecting(false);
            else if (pc.currentRemoteDescription && !pc.currentLocalDescription && callData.offer) {
                // This indicates that the remote (answer) is set, but the local (original offer) isn't explicitly set on this new PC instance.
                // WebRTC might implicitly use the local tracks. This scenario should be okay.
                 console.log("VideoCallView (Rejoining Caller): Remote is set, local (original offer) not set on this PC instance, but should be implicitly handled.");
                 setIsConnecting(false);
            }
          }
      } else if (callData && callData.status === 'ringing' && !callData.calleeId && callData.callerId !== localUser.uid) { // User is Callee
        isCallerRef.current = false;
        console.log("VideoCallView: User is Callee. Joining call. PC State:", pc.signalingState);

        if (callData.isAudioOnly !== isAudioOnly) {
          toast({variant: "destructive", title: "Call Type Mismatch", description: `This call is ${callData.isAudioOnly ? 'audio-only' : 'video'}. You tried to join with a different type.`});
          if (!localUserInitiatedEndRef.current) onEndCall(); return;
        }

        if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-offer') { // Should be stable before setting remote offer
            console.error("VideoCallView (Callee): PC not stable for setRemoteDescription (offer). State:", pc.signalingState);
            throw new Error("PeerConnection not stable for setting remote offer.");
        }
        await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));
        console.log("VideoCallView (Callee): Remote description (offer) set. PC State:", pc.signalingState);
        
        if (pc.signalingState !== 'have-remote-offer') {
          console.error("VideoCallView (Callee): PC not in have-remote-offer state for createAnswer. State:", pc.signalingState);
          throw new Error("PeerConnection not in have-remote-offer state for creating answer.");
        }
        const answerDescription = await pc.createAnswer();
        await pc.setLocalDescription(answerDescription);
        console.log("VideoCallView (Callee): Local description (answer) set. PC State:", pc.signalingState);

        await updateDoc(callDocRef, {
          calleeId: localUser.uid,
          calleeName: localUser.displayName || "Anonymous Callee",
          answer: { type: answerDescription.type, sdp: answerDescription.sdp },
          status: 'active',
          joinedAt: serverTimestamp(),
        });
        console.log("VideoCallView (Callee): Call document updated with answer, status active.");
        setIsConnecting(false);
      } else if (callData && callData.status === 'active' && callData.calleeId === localUser.uid) { // Original Callee rejoining
          isCallerRef.current = false;
          console.log("VideoCallView (Rejoining Callee): User is original Callee. PC State:", pc.signalingState);
          if (callData.isAudioOnly !== isAudioOnly) { /* ... type mismatch ... */ }

          if (callData.offer && !pc.currentRemoteDescription) {
              try {
                await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));
                console.log("VideoCallView (Rejoining Callee): Remote description (offer) set.");
              } catch (e) { /* error handling */ throw e; }
          }
          if (callData.answer && !pc.currentLocalDescription && pc.signalingState === 'have-remote-offer') {
            try {
              await pc.setLocalDescription(new RTCSessionDescription(callData.answer));
              console.log("VideoCallView (Rejoining Callee): Local description (answer) set.");
            } catch (e) { /* error handling */ throw e;}
          }
          if (pc.currentRemoteDescription && pc.currentLocalDescription) setIsConnecting(false);

      } else if (callData && callData.status === 'active' && callData.callerId !== localUser.uid && callData.calleeId !== localUser.uid) {
        console.warn("VideoCallView: Call is busy with other participants.");
        toast({variant: "destructive", title: "Call Busy", description: "This call is already in progress with other users."});
        if (!localUserInitiatedEndRef.current) onEndCall(); return;
      } else {
        console.warn("VideoCallView: Call document in unexpected state or user not part of active call. User:", localUser.uid, "Call Data:", callData);
        toast({variant: "destructive", title: "Call Error", description: "Could not join the call due to an unexpected state."});
        if (!localUserInitiatedEndRef.current) onEndCall(); return;
      }

      // Firestore Listeners
      // Listener for the main call document
      callDocUnsubscribeRef.current = onSnapshot(callDocRef, async (snapshot: DocumentSnapshot<DocumentData>) => {
        const data = snapshot.data();
        console.log("VideoCallView (CallDoc Listener): Update. Data:", data, "PC Signaling State:", pc?.signalingState, "isCallerRef:", isCallerRef.current);
        
        if (!snapshot.exists()) {
          console.log("VideoCallView (CallDoc Listener): Call document deleted remotely.");
          if (!localUserInitiatedEndRef.current) {
            toast({title: "Call Ended", description: "The call document was removed."});
            onEndCall();
          }
          return;
        }

        if (isCallerRef.current === true) { // Current user is Caller
          if (data?.answer && pc && (pc.signalingState === 'have-local-offer' || pc.signalingState === 'stable') && !pc.currentRemoteDescription) {
            try {
              console.log("VideoCallView (CallDoc Listener - Caller): Received answer. Setting remote description.", data.answer);
              await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
              console.log("VideoCallView (CallDoc Listener - Caller): Remote description (answer) set. PC State:", pc.signalingState);
            } catch (e: any) {
              console.error("VideoCallView (CallDoc Listener - Caller): Error setting remote description (answer):", e.message, "Signaling state:", pc.signalingState);
            }
          }
          if (data?.status && ['ended', 'ended_by_callee'].includes(data.status) && !localUserInitiatedEndRef.current) {
            console.log("VideoCallView (CallDoc Listener - Caller): Call ended by callee or globally. Status:", data.status);
            toast({title: "Call Ended", description: "The other user has ended the call."});
            onEndCall();
          }
        } else if (isCallerRef.current === false) { // Current user is Callee
           if (data?.status && ['ended', 'ended_by_caller'].includes(data.status) && !localUserInitiatedEndRef.current) {
              console.log("VideoCallView (CallDoc Listener - Callee): Call ended by caller or globally. Status:", data.status);
              toast({title: "Call Ended", description: "The other user has ended the call."});
              onEndCall();
           }
        }
      });

      // Listen for ICE candidates
      const candidatesCollectionPath = isCallerRef.current ? `calls/${callId}/calleeCandidates` : `calls/${callId}/callerCandidates`;
      const candidatesUnsubscribeRef = isCallerRef.current ? calleeCandidatesUnsubscribeRef : callerCandidatesUnsubscribeRef;
      
      console.log("VideoCallView: Listening for ICE candidates on path:", candidatesCollectionPath);
      candidatesUnsubscribeRef.current = onSnapshot(collection(firestore, candidatesCollectionPath), snapshot => {
        snapshot.docChanges().forEach(async change => {
          if (change.type === 'added') {
            const candidate = change.doc.data();
            console.log("VideoCallView: Received remote ICE candidate:", candidate, "PC State:", pc?.signalingState, "RemoteDesc:", pc?.currentRemoteDescription);
            if (pc && (pc.remoteDescription || pc.currentRemoteDescription)) {
               try { 
                 await pc.addIceCandidate(new RTCIceCandidate(candidate));
                 console.log("VideoCallView: Added remote ICE candidate successfully.");
               }
               catch (e) { console.error("VideoCallView: Error adding received ICE candidate:", e); }
            } else {
              console.warn("VideoCallView: Received ICE candidate but remote description not set yet or PC not available. Candidate ignored or queued by browser.");
            }
          }
        });
      });

    } catch (error: any) {
      console.error('VideoCallView: Error during initializeCall function:', error, error.stack);
      let title = 'Media Access Error';
      let description = `Could not start ${isAudioOnly ? 'audio' : 'video'} call.`;

      if (hasMediaPermission) {
        title = 'Call Setup Error';
        description = `Failed to set up the call. ${error.message || 'Please try again.'}`;
      } else {
        setHasMediaPermission(false); 
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
          description = 'Camera and microphone access was denied. Please enable it in your browser settings.';
        } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
          description = 'No camera or microphone found. Please ensure they are connected and enabled.';
        } else {
           description = error.message || 'An unexpected error occurred while accessing media devices.';
        }
      }
      toast({ variant: 'destructive', title, description, duration: 7000 });
      if (!localUserInitiatedEndRef.current) onEndCall();
    }
  }, [callId, localUser, isAudioOnly, onEndCall, toast, isCameraOff, isMuted, cleanupCall]);

  useEffect(() => {
    if (localUser?.uid && callId) { 
        initializeCall();
    } else {
        console.error("VideoCallView: Local user or callId not available, cannot initialize call.");
        if (!localUserInitiatedEndRef.current) onEndCall();
    }

    return () => {
      console.log("VideoCallView: useEffect cleanup for callId:", callId, "Local initiated end:", localUserInitiatedEndRef.current);
      // Call cleanup only if unmount wasn't due to local user explicitly ending the call
      // (which would have already called cleanupCall with initiatedByLocalUser = true)
      if (!localUserInitiatedEndRef.current) { 
        cleanupCall(false); 
      }
    };
  }, [initializeCall, cleanupCall, callId, localUser, onEndCall]);


  const handleLocalEndCall = useCallback(async () => {
    console.log("VideoCallView: User clicked end call button for callId:", callId);
    await cleanupCall(true); 
    onEndCall(); 
  }, [cleanupCall, onEndCall, callId]);


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
                <p className="text-lg font-medium">Connected (Audio)</p>
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
                  <p> {isCallerRef.current === null ? "Initializing..." : (isCallerRef.current ? `Calling (${isAudioOnly ? 'Audio' : 'Video'})...` : `Joining (${isAudioOnly ? 'Audio' : 'Video'})...`)} </p>
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
