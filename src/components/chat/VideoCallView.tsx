
"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Mic, MicOff, PhoneOff, Video, VideoOff } from "lucide-react";
import Image from "next/image";
import { useState, useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface VideoCallViewProps {
  onEndCall: () => void;
}

export function VideoCallView({ onEndCall }: VideoCallViewProps) {
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [hasCameraPermission, setHasCameraPermission] = useState<boolean | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null); // Placeholder for remote video
  const { toast } = useToast();

  useEffect(() => {
    // This is a placeholder for WebRTC logic.
    // In a real app, you would:
    // 1. Get user media (camera and microphone)
    // 2. Set up RTCPeerConnection
    // 3. Handle signaling (e.g., with Firebase) to exchange SDP and ICE candidates
    // 4. Attach local and remote streams to video elements

    const getCameraPermission = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        setHasCameraPermission(true);

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
        // In a real app, send this stream to the remote peer
      } catch (error) {
        console.error('Error accessing camera/microphone:', error);
        setHasCameraPermission(false);
        toast({
          variant: 'destructive',
          title: 'Media Access Denied',
          description: 'Please enable camera and microphone permissions in your browser settings.',
        });
      }
    };

    getCameraPermission();

    return () => {
      // Clean up: stop media tracks when component unmounts or call ends
      if (localVideoRef.current && localVideoRef.current.srcObject) {
        const stream = localVideoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [toast]);

  const toggleMute = () => {
    setIsMuted(!isMuted);
    if (localVideoRef.current && localVideoRef.current.srcObject) {
      const stream = localVideoRef.current.srcObject as MediaStream;
      stream.getAudioTracks().forEach(track => track.enabled = isMuted); // isMuted is previous state here
    }
    // Add logic to signal mute state to remote peer
  };

  const toggleCamera = () => {
    setIsCameraOff(!isCameraOff);
     if (localVideoRef.current && localVideoRef.current.srcObject) {
      const stream = localVideoRef.current.srcObject as MediaStream;
      stream.getVideoTracks().forEach(track => track.enabled = isCameraOff); // isCameraOff is previous state here
    }
    // Add logic to signal camera state to remote peer
  };

  return (
    <div className="flex flex-col h-full p-4 bg-card items-center justify-center relative">
      {/* This is a UI placeholder for a video call. WebRTC implementation is required. */}
      
      {hasCameraPermission === false && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Camera & Microphone Access Required</AlertTitle>
          <AlertDescription>
            Please allow camera and microphone access to use video calling.
            You might need to adjust your browser settings.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 w-full h-full flex-1">
        {/* Remote Video - Main View */}
        <div className="md:col-span-4 bg-muted rounded-lg overflow-hidden flex items-center justify-center relative aspect-video md:aspect-auto">
           {/* In a real app, remoteVideoRef would be used here */}
          <Image 
            src="https://placehold.co/1280x720.png" 
            alt="Remote Video Placeholder" 
            layout="fill"
            objectFit="cover"
            className="bg-muted"
            data-ai-hint="video screen other person"
          />
          <p className="absolute bottom-4 left-4 bg-black/50 text-white px-2 py-1 rounded text-sm">Remote User</p>
        </div>

        {/* Local Video - Picture-in-Picture style */}
        <div className="md:col-span-1 flex flex-col gap-4">
            <div className="bg-muted rounded-lg overflow-hidden aspect-video relative flex-shrink-0">
              {hasCameraPermission ? (
                <video ref={localVideoRef} className="w-full h-full object-cover" autoPlay muted playsInline />
              ) : (
                 <Image 
                    src="https://placehold.co/640x480.png" 
                    alt="Local Video Placeholder" 
                    layout="fill"
                    objectFit="cover"
                    className="bg-muted"
                    data-ai-hint="webcam feed self"
                  />
              )}
              <p className="absolute bottom-2 left-2 bg-black/50 text-white px-1.5 py-0.5 rounded text-xs">You</p>
            </div>
            <div className="hidden md:block p-2 bg-muted/50 rounded-lg text-center text-sm text-foreground/70">
              <p>Video call active. WebRTC logic would be here.</p>
            </div>
        </div>
      </div>

      {/* Call Controls */}
      <Card className="absolute bottom-4 left-1/2 transform -translate-x-1/2 shadow-xl">
        <CardContent className="p-3 flex items-center gap-3">
          <Button variant={isMuted ? "destructive" : "secondary"} size="icon" onClick={toggleMute} aria-label={isMuted ? "Unmute" : "Mute"}>
            {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </Button>
          <Button variant={isCameraOff ? "destructive" : "secondary"} size="icon" onClick={toggleCamera} aria-label={isCameraOff ? "Turn camera on" : "Turn camera off"}>
            {isCameraOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
          </Button>
          <Button variant="destructive" size="icon" onClick={onEndCall} aria-label="End call">
            <PhoneOff className="h-5 w-5" />
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
