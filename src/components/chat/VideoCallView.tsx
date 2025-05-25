
"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Mic, MicOff, PhoneOff, Video, VideoOff, Loader2 } from "lucide-react";
import Image from "next/image";
import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useAuth } from "@/contexts/AuthContext";
// FIRESTORE_TODO: import { doc, onSnapshot, setDoc, updateDoc, collection, addDoc, getDoc, deleteDoc } from "firebase/firestore";
// FIRESTORE_TODO: import { firestore } from "@/lib/firebase";

interface VideoCallViewProps {
  callId: string;
  onEndCall: () => void;
}

// Standard public STUN servers
const stunServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function VideoCallView({ callId, onEndCall }: VideoCallViewProps) {
  const { currentUser } = useAuth();
  const { toast } = useToast();

  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [hasMediaPermission, setHasMediaPermission] = useState<boolean | null>(null);
  const [isConnecting, setIsConnecting] = useState(true); // Initial state is connecting

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  const cleanupCall = useCallback(() => {
    console.log("Cleaning up call resources...");
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }
    if (peerConnection) {
      peerConnection.close();
      setPeerConnection(null);
    }
    setRemoteStream(null);
    // FIRESTORE_TODO: Update call document status to 'ended' or delete it.
    // Example: updateDoc(doc(firestore, 'calls', callId), { status: 'ended' });
  }, [localStream, peerConnection]);


  // Initialize Peer Connection and Media
  useEffect(() => {
    const initialize = async () => {
      if (!currentUser) {
        toast({ variant: "destructive", title: "Authentication Error", description: "User not found."});
        onEndCall();
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        setLocalStream(stream);
        setHasMediaPermission(true);
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        const pc = new RTCPeerConnection(stunServers);
        setPeerConnection(pc);

        stream.getTracks().forEach(track => pc.addTrack(track, stream));

        pc.onicecandidate = event => {
          if (event.candidate) {
            console.log("Generated ICE candidate:", event.candidate);
            // FIRESTORE_TODO: Send candidate to the other peer via signaling server
            // Example: addDoc(collection(firestore, `calls/${callId}/callerCandidates`), { ...event.candidate.toJSON() });
            // (or calleeCandidates depending on who this is)
          }
        };

        pc.ontrack = event => {
          console.log("Received remote track:", event.streams[0]);
          setRemoteStream(event.streams[0]);
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = event.streams[0];
          }
          setIsConnecting(false); // Got remote track, no longer just "connecting"
        };
        
        pc.onconnectionstatechange = () => {
          console.log("Peer connection state:", pc.connectionState);
          if (pc.connectionState === 'connected') {
            setIsConnecting(false);
          } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
            setIsConnecting(false); // Or handle as an error/ended call
            // onEndCall(); // Consider if call should end here
          }
        };

        // FIRESTORE_TODO: Signaling logic starts here.
        // This is a simplified conceptual flow. A real implementation needs robust state management.
        // const callDocRef = doc(firestore, 'calls', callId);
        
        // Example: Check if call document exists. If not, create it (caller). If yes, join it (callee).
        // const callDocSnap = await getDoc(callDocRef);

        // if (!callDocSnap.exists()) { // Assume this user is the caller
        //   await setDoc(callDocRef, { callerId: currentUser.uid, status: 'ringing' });
        //   const offer = await pc.createOffer();
        //   await pc.setLocalDescription(offer);
        //   await updateDoc(callDocRef, { offer: offer });
        //   console.log("Created offer and updated call document.");
        // } else { // Assume this user is the callee
        //   const callData = callDocSnap.data();
        //   if (callData.offer && callData.callerId !== currentUser.uid) {
        //     await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));
        //     const answer = await pc.createAnswer();
        //     await pc.setLocalDescription(answer);
        //     await updateDoc(callDocRef, { answer: answer, calleeId: currentUser.uid, status: 'active' });
        //     console.log("Set remote offer, created answer and updated call document.");
        //     setIsConnecting(false);
        //   }
        // }

        // FIRESTORE_TODO: Listen for changes on callDocRef (offers, answers, candidates)
        // const unsubscribe = onSnapshot(callDocRef, async (snapshot) => {
        //   const data = snapshot.data();
        //   if (!data) return;

        //   // Caller receives answer
        //   if (data.answer && pc.signalingState !== 'stable' && currentUser.uid === data.callerId) {
        //     await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        //     console.log("Set remote answer.");
        //     setIsConnecting(false);
        //   }
        //   // Handle ICE candidates (simplified)
        //   // Need separate listeners for callerCandidates and calleeCandidates collections
        // });
        // return () => unsubscribe(); // Cleanup listener

        // For now, let's assume connection will be established or timeout
        setTimeout(() => { 
          if(isConnecting && !remoteStream) {
             // Still connecting after timeout and no remote stream
             console.warn("Video call connection timeout or no remote stream.");
             // Potentially show a message or auto-end call
          }
        }, 20000); // 20s timeout example

      } catch (error) {
        console.error('Error initializing video call:', error);
        setHasMediaPermission(false);
        let description = 'Please enable camera and microphone permissions in your browser settings.';
        if (error instanceof Error) {
          if (error.name === 'NotAllowedError') {
            description = 'Camera and microphone access was denied. Please enable it in your browser settings and refresh.';
          } else if (error.name === 'NotFoundError') {
            description = 'No camera or microphone found. Please ensure they are connected and enabled.';
          }
        }
        toast({ variant: 'destructive', title: 'Media Access Error', description });
        onEndCall(); // End call if permissions fail
      }
    };

    initialize();

    return () => {
      cleanupCall();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, currentUser, toast, onEndCall]); // `cleanupCall` is memoized

  const handleEndCall = () => {
    cleanupCall();
    onEndCall(); // Propagate to parent
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
        <p className="text-muted-foreground">Requesting media permissions...</p>
      </div>
    );
  }
  
  return (
    <div className="flex flex-col h-full p-4 bg-card items-center justify-center relative">
      {hasMediaPermission === false && ( /* This alert is for when permission is definitively denied */
        <Alert variant="destructive" className="mb-4 absolute top-4 left-1/2 -translate-x-1/2 z-10 max-w-lg w-full">
          <AlertTitle>Media Access Required</AlertTitle>
          <AlertDescription>
            Video calling requires camera and microphone access. 
            Please enable permissions in your browser settings and refresh the page.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 w-full h-full flex-1">
        {/* Remote Video - Main View */}
        <div className="md:col-span-4 bg-muted rounded-lg overflow-hidden flex items-center justify-center relative aspect-video md:aspect-auto">
          <video 
            ref={remoteVideoRef} 
            className="w-full h-full object-cover" 
            autoPlay 
            playsInline
            style={{ display: remoteStream ? 'block' : 'none' }}
          />
          {!remoteStream && (
            <div className="flex flex-col items-center text-muted-foreground">
              {isConnecting && hasMediaPermission ? (
                <>
                  <Loader2 className="h-12 w-12 animate-spin mb-2" />
                  <p>Connecting to peer...</p>
                </>
              ) : (
                <>
                  <VideoOff className="h-16 w-16 mb-2" />
                   <p>{hasMediaPermission ? "Waiting for remote video..." : "Remote video unavailable"}</p>
                </>
              )}
            </div>
          )}
          <p className="absolute bottom-4 left-4 bg-black/50 text-white px-2 py-1 rounded text-sm">Remote User</p>
        </div>

        {/* Local Video - Picture-in-Picture style */}
        <div className="md:col-span-1 flex flex-col gap-4">
            <div className="bg-muted rounded-lg overflow-hidden aspect-video relative flex-shrink-0">
              <video 
                ref={localVideoRef} 
                className="w-full h-full object-cover" 
                autoPlay 
                muted 
                playsInline 
                style={{ display: localStream && !isCameraOff ? 'block' : 'none' }}
              />
              {(!localStream || isCameraOff) && (
                 <div className="w-full h-full bg-muted flex items-center justify-center">
                    {isCameraOff && localStream ? <VideoOff className="h-12 w-12 text-foreground/50" /> : <User className="h-12 w-12 text-foreground/50" /> }
                 </div>
              )}
              <p className="absolute bottom-2 left-2 bg-black/50 text-white px-1.5 py-0.5 rounded text-xs">You {isMuted && "(Muted)"}</p>
            </div>
            <div className="hidden md:block p-2 bg-muted/50 rounded-lg text-center text-sm text-foreground/70 overflow-auto">
              <p className="font-semibold mb-1">Call ID: {callId}</p>
              <p>Full WebRTC P2P connection logic and signaling via Firestore is partially stubbed and needs completion.</p>
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
const User = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
  </svg>
);

