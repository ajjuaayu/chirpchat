
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
  const [isCameraOff, setIsCameraOff] = useState(isAudioOnly); // Initialize based on call type
  const [hasMediaPermission, setHasMediaPermission] = useState<boolean | null>(null);
  const [isConnecting, setIsConnecting] = useState(true);
  
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  
  // Refs for Firestore listeners to ensure they are unsubscribed
  const callDocUnsubscribeRef = useRef<Unsubscribe | null>(null);
  const callerCandidatesUnsubscribeRef = useRef<Unsubscribe | null>(null);
  const calleeCandidatesUnsubscribeRef = useRef<Unsubscribe | null>(null);

  const localUserInitiatedEndRef = useRef(false);
  const isCallerRef = useRef<boolean | null>(null); // To keep track of role without relying on async state

  // Comprehensive cleanup function
  const cleanupCall = useCallback(async (initiatedByLocalUser = false) => {
    console.log(`VideoCallView: cleanupCall triggered. callId: ${callId}, Local initiated: ${initiatedByLocalUser}`);
    localUserInitiatedEndRef.current = initiatedByLocalUser;

    // Stop media tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    remoteStreamRef.current = null;

    // Close peer connection
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

    // Unsubscribe from Firestore listeners
    if (callDocUnsubscribeRef.current) {
      callDocUnsubscribeRef.current();
      callDocUnsubscribeRef.current = null;
      console.log("VideoCallView: Unsubscribed from call document.");
    }
    if (callerCandidatesUnsubscribeRef.current) {
      callerCandidatesUnsubscribeRef.current();
      callerCandidatesUnsubscribeRef.current = null;
    }
    if (calleeCandidatesUnsubscribeRef.current) {
      calleeCandidatesUnsubscribeRef.current();
      calleeCandidatesUnsubscribeRef.current = null;
    }
    
    // Firestore cleanup if this user initiated the end
    if (initiatedByLocalUser && callId && localUser.uid) {
      const callDocRef = doc(firestore, 'calls', callId);
      try {
        const callDocSnap = await getDoc(callDocRef);
        if (callDocSnap.exists()) {
          const callData = callDocSnap.data();
          const userWasCaller = callData.callerId === localUser.uid;
          const userWasCallee = callData.calleeId === localUser.uid;

          if (userWasCaller && callData.status !== 'ended_by_caller' && callData.status !== 'ended') {
            await updateDoc(callDocRef, { status: 'ended_by_caller', endedAt: serverTimestamp() });
            console.log("VideoCallView: Caller ended call, updated status in Firestore.");
          } else if (userWasCallee && callData.status !== 'ended_by_callee' && callData.status !== 'ended') {
            await updateDoc(callDocRef, { status: 'ended_by_callee', endedAt: serverTimestamp() });
            console.log("VideoCallView: Callee ended call, updated status in Firestore.");
          }
          
          // If both parties have ended, or one party ends an already ended call, delete the document and subcollections
          const updatedCallSnap = await getDoc(callDocRef); // Get fresh data
          if (updatedCallSnap.exists()) {
            const updatedCallData = updatedCallSnap.data();
            const otherPartyEnded = (userWasCaller && updatedCallData.status === 'ended_by_callee') ||
                                    (userWasCallee && updatedCallData.status === 'ended_by_caller') ||
                                    updatedCallData.status === 'ended'; // Or if it was already generically 'ended'
            
            if (otherPartyEnded || ( (userWasCaller && updatedCallData.status === 'ended_by_caller') || (userWasCallee && updatedCallData.status === 'ended_by_callee') ) && !updatedCallData.calleeId && userWasCaller) { // Caller ends before callee joins
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
  }, [callId, localUser.uid, toast]); // Added toast to useCallback dependencies

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
        stream.getVideoTracks().forEach(track => track.enabled = !isCameraOff); // Use state for initial camera on/off
      }
      stream.getAudioTracks().forEach(track => track.enabled = !isMuted); // Use state for initial mute

      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      setHasMediaPermission(true);

      peerConnectionRef.current = new RTCPeerConnection(stunServers);
      const pc = peerConnectionRef.current;
      console.log("VideoCallView: RTCPeerConnection created.");

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
          setIsConnecting(false); // Connected when remote track is received
        }
      };
      
      pc.onconnectionstatechange = () => {
        console.log("VideoCallView: Peer connection state changed to:", pc.connectionState);
        if (pc.connectionState === 'connected') {
          setIsConnecting(false);
        } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
           console.warn("VideoCallView: Peer connection state is disconnected, failed, or closed:", pc.connectionState);
           if (!localUserInitiatedEndRef.current) { 
               onEndCall(); 
           }
        }
      };

      pc.onsignalingstatechange = () => {
          console.log("VideoCallView: Peer signaling state changed to:", pc.signalingState);
      }
      pc.oniceconnectionstatechange = () => {
          console.log("VideoCallView: Peer ICE connection state changed to:", pc.iceConnectionState);
           if (pc.iceConnectionState === 'failed' && !localUserInitiatedEndRef.current) {
              console.error("VideoCallView: ICE connection failed.");
              toast({variant: "destructive", title: "Connection Failed", description: "Could not establish a stable connection."});
              if (!localUserInitiatedEndRef.current) onEndCall();
          }
      };

      // Firestore Signaling
      const callDocRef = doc(firestore, 'calls', callId);
      const callDocSnap = await getDoc(callDocRef);

      if (!callDocSnap.exists() || (callDocSnap.exists() && ['ended', 'ended_by_caller', 'ended_by_callee'].includes(callDocSnap.data()?.status))) {
        // This user is the caller
        isCallerRef.current = true;
        console.log("VideoCallView: User is Caller. Creating call document.");

        if (callDocSnap.exists()) { // Clean up stale/ended document
            console.log("VideoCallView: Found stale/ended call document. Deleting before creating new one.");
            const batch = writeBatch(firestore);
            const oldCallerCandidates = await getDocs(query(collection(firestore, `calls/${callId}/callerCandidates`)));
            oldCallerCandidates.forEach((d) => batch.delete(d.ref));
            const oldCalleeCandidates = await getDocs(query(collection(firestore, `calls/${callId}/calleeCandidates`)));
            oldCalleeCandidates.forEach((d) => batch.delete(d.ref));
            batch.delete(callDocRef);
            await batch.commit();
            console.log("VideoCallView: Stale call document and candidates deleted.");
        }
        
        if (pc.signalingState !== 'stable') {
            console.error("VideoCallView (Caller): PC not stable for createOffer. State:", pc.signalingState);
            throw new Error("PeerConnection not stable for creating offer.");
        }
        const offerDescription = await pc.createOffer();
        await pc.setLocalDescription(offerDescription);
        console.log("VideoCallView (Caller): Local description (offer) set.");

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

        // Listen for answer from callee
        callDocUnsubscribeRef.current = onSnapshot(callDocRef, async (snapshot: DocumentSnapshot<DocumentData>) => {
          const data = snapshot.data();
          console.log("VideoCallView (Caller): Call doc update. Data:", data, "PC Signaling State:", pc.signalingState);
          if (!snapshot.exists() && !localUserInitiatedEndRef.current) {
            console.log("VideoCallView (Caller): Call document deleted remotely.");
            if (!localUserInitiatedEndRef.current) onEndCall();
            return;
          }
          if (data?.answer && pc.signalingState === 'have-local-offer') {
            try {
              await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
              console.log("VideoCallView (Caller): Remote description (answer) set.");
            } catch (e: any) {
              console.error("VideoCallView (Caller): Error setting remote description (answer):", e.message, "Signaling state:", pc.signalingState);
            }
          }
           if (data?.status && ['ended', 'ended_by_callee'].includes(data.status) && !localUserInitiatedEndRef.current) {
            console.log("VideoCallView (Caller): Call ended by callee or globally. Status:", data.status);
            toast({title: "Call Ended", description: "The other user has ended the call."});
            if (!localUserInitiatedEndRef.current) onEndCall();
          }
        });

        // Listen for callee's ICE candidates
        calleeCandidatesUnsubscribeRef.current = onSnapshot(collection(firestore, `calls/${callId}/calleeCandidates`), snapshot => {
          snapshot.docChanges().forEach(async change => {
            if (change.type === 'added') {
              const candidate = change.doc.data();
              console.log("VideoCallView (Caller): Received callee ICE candidate:", candidate);
              if (pc.remoteDescription || pc.currentRemoteDescription) { // Check if remote description is set
                 try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
                 catch (e) { console.error("VideoCallView (Caller): Error adding received ICE candidate:", e); }
              } else {
                console.warn("VideoCallView (Caller): Received ICE candidate but remote description not set yet. Candidate queued implicitly by browser or ignored.");
              }
            }
          });
        });

      } else {
        // Call document exists, user might be callee or rejoining
        const callData = callDocSnap.data()!;
        console.log("VideoCallView: Existing call document found:", callData);

        if (callData.isAudioOnly !== isAudioOnly) {
          toast({variant: "destructive", title: "Call Type Mismatch", description: `This call is ${callData.isAudioOnly ? 'audio-only' : 'video'}. You tried to join with a different type.`});
          if (!localUserInitiatedEndRef.current) onEndCall(); return;
        }

        if (callData.callerId === localUser.uid) {
          // User is the original caller, possibly rejoining/re-establishing
          isCallerRef.current = true;
          console.log("VideoCallView: User is original Caller, re-establishing.");
          // If offer is there and PC localDesc isn't set, set it.
          if (callData.offer && !pc.currentLocalDescription && pc.signalingState === 'stable') {
            await pc.setLocalDescription(new RTCSessionDescription(callData.offer));
          }
          // If answer is there and PC remoteDesc isn't set, set it.
          if (callData.answer && !pc.currentRemoteDescription && (pc.signalingState === 'have-local-offer' || (pc.signalingState === 'stable' && pc.currentLocalDescription))) {
            await pc.setRemoteDescription(new RTCSessionDescription(callData.answer));
          }
          if (pc.currentRemoteDescription && pc.currentLocalDescription) setIsConnecting(false);
          
          // Re-establish listeners (similar to caller block)
           callDocUnsubscribeRef.current = onSnapshot(callDocRef, (snapshot) => { /* ... same as caller's listener ... */ 
            const data = snapshot.data();
            if (!snapshot.exists() && !localUserInitiatedEndRef.current) {
                console.log("VideoCallView (Rejoining Caller): Call document deleted.");
                if (!localUserInitiatedEndRef.current) onEndCall(); return;
            }
            if (data?.status && ['ended', 'ended_by_callee'].includes(data.status) && !localUserInitiatedEndRef.current) {
                console.log("VideoCallView (Rejoining Caller): Call ended by callee or globally.");
                toast({title: "Call Ended", description: "The other user has ended the call."});
                if (!localUserInitiatedEndRef.current) onEndCall();
            }
           });
           calleeCandidatesUnsubscribeRef.current = onSnapshot(collection(firestore, `calls/${callId}/calleeCandidates`), snapshot => { /* ... */ });


        } else if (callData.status === 'ringing' && !callData.calleeId) {
          // User is Callee, joining a ringing call
          isCallerRef.current = false;
          console.log("VideoCallView: User is Callee. Joining call.");

          if (pc.signalingState !== 'stable') {
            console.error("VideoCallView (Callee): PC not stable for setRemoteDescription. State:", pc.signalingState);
            throw new Error("PeerConnection not stable for setting remote offer.");
          }
          await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));
          console.log("VideoCallView (Callee): Remote description (offer) set.");
          
          if (pc.signalingState !== 'have-remote-offer') {
            console.error("VideoCallView (Callee): PC not in have-remote-offer state for createAnswer. State:", pc.signalingState);
            throw new Error("PeerConnection not in have-remote-offer state for creating answer.");
          }
          const answerDescription = await pc.createAnswer();
          await pc.setLocalDescription(answerDescription);
          console.log("VideoCallView (Callee): Local description (answer) set.");

          await updateDoc(callDocRef, {
            calleeId: localUser.uid,
            calleeName: localUser.displayName || "Anonymous Callee",
            answer: { type: answerDescription.type, sdp: answerDescription.sdp },
            status: 'active',
            joinedAt: serverTimestamp(),
          });
          console.log("VideoCallView (Callee): Call document updated with answer, status active.");
          setIsConnecting(false);

          // Listen for caller's ICE candidates
          callerCandidatesUnsubscribeRef.current = onSnapshot(collection(firestore, `calls/${callId}/callerCandidates`), snapshot => {
            snapshot.docChanges().forEach(async change => {
              if (change.type === 'added') {
                const candidate = change.doc.data();
                console.log("VideoCallView (Callee): Received caller ICE candidate:", candidate);
                 if (pc.remoteDescription || pc.currentRemoteDescription) {
                    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
                    catch (e) { console.error("VideoCallView (Callee): Error adding received ICE candidate:", e); }
                 } else {
                    console.warn("VideoCallView (Callee): Received ICE candidate but remote description not set yet.");
                 }
              }
            });
          });
          
          // Listen for call doc changes (e.g. caller ending call)
          callDocUnsubscribeRef.current = onSnapshot(callDocRef, (snapshot) => {
             const data = snapshot.data();
             if (!snapshot.exists() && !localUserInitiatedEndRef.current) {
                console.log("VideoCallView (Callee): Call document deleted.");
                if (!localUserInitiatedEndRef.current) onEndCall(); return;
             }
             if (data?.status && ['ended', 'ended_by_caller'].includes(data.status) && !localUserInitiatedEndRef.current) {
                console.log("VideoCallView (Callee): Call ended by caller or globally.");
                toast({title: "Call Ended", description: "The other user has ended the call."});
                if (!localUserInitiatedEndRef.current) onEndCall();
             }
          });


        } else if (callData.status === 'active' && callData.calleeId === localUser.uid) {
            isCallerRef.current = false;
            console.log("VideoCallView: User is original Callee, re-establishing.");
            if (callData.offer && !pc.currentRemoteDescription && pc.signalingState === 'stable') {
                 await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));
            }
            if (callData.answer && !pc.currentLocalDescription && (pc.signalingState === 'have-remote-offer' || (pc.signalingState === 'stable' && pc.currentRemoteDescription ))) {
                await pc.setLocalDescription(new RTCSessionDescription(callData.answer));
            }
            if (pc.currentRemoteDescription && pc.currentLocalDescription) setIsConnecting(false);

            // Re-establish listeners
            callerCandidatesUnsubscribeRef.current = onSnapshot(collection(firestore, `calls/${callId}/callerCandidates`), snapshot => { /* ... */ });
            callDocUnsubscribeRef.current = onSnapshot(callDocRef, (snapshot) => { /* ... */ });


        } else if (callData.status === 'active' && callData.callerId !== localUser.uid && callData.calleeId !== localUser.uid) {
          console.warn("VideoCallView: Call is busy with other participants.");
          toast({variant: "destructive", title: "Call Busy", description: "This call is already in progress."});
          if (!localUserInitiatedEndRef.current) onEndCall(); return;
        } else {
          console.warn("VideoCallView: Call document in unexpected state or user not part of active call. User:", localUser.uid, "Call Data:", callData);
          toast({variant: "destructive", title: "Call Error", description: "Could not join the call due to an unexpected state."});
          if (!localUserInitiatedEndRef.current) onEndCall(); return;
        }
      }
    } catch (error: any) {
      console.error('VideoCallView: Error during initializeCall function:', error, error.stack);
      let title = 'Media Access Error';
      let description = `Could not start ${isAudioOnly ? 'audio' : 'video'} call.`;

      if (hasMediaPermission) { // if true, media was acquired, so it's a setup error
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
  }, [callId, localUser, isAudioOnly, onEndCall, toast, isCameraOff, isMuted]); // Added isCameraOff and isMuted

  useEffect(() => {
    if (localUser?.uid && callId) { 
        initializeCall();
    } else {
        console.error("VideoCallView: Local user or callId not available, cannot initialize call.");
        if (!localUserInitiatedEndRef.current) onEndCall();
    }

    return () => {
      console.log("VideoCallView: useEffect cleanup for callId:", callId, "localUserInitiatedEndRef:", localUserInitiatedEndRef.current);
      if (!localUserInitiatedEndRef.current) { 
        cleanupCall(false); // Call cleanup if unmount wasn't locally initiated by button click
      }
    };
  }, [initializeCall, cleanupCall, localUser, callId, onEndCall]); // Added onEndCall to dependencies of main useEffect

  const handleLocalEndCall = async () => {
    console.log("VideoCallView: User clicked end call button for callId:", callId);
    localUserInitiatedEndRef.current = true; // Mark that this user is ending the call
    await cleanupCall(true); // Pass true to indicate local user initiated the full cleanup sequence
    onEndCall(); // Notify parent component
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
