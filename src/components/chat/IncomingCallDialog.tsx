
"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Phone, Video } from "lucide-react";

interface IncomingCallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  callerName?: string | null;
  isAudioOnly: boolean;
  onAccept: () => void;
  onReject: () => void;
}

export function IncomingCallDialog({
  open,
  onOpenChange,
  callerName,
  isAudioOnly,
  onAccept,
  onReject,
}: IncomingCallDialogProps) {
  const handleAccept = () => {
    onAccept();
    onOpenChange(false);
  };

  const handleReject = () => {
    onReject();
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-sm rounded-lg shadow-xl">
        <AlertDialogHeader className="text-center">
          <div className="mx-auto mb-4">
            {/* Placeholder for caller avatar or generic icon */}
            <Avatar className="h-20 w-20 border-2 border-primary">
              <AvatarImage src={undefined} />
              <AvatarFallback className="text-3xl">
                {callerName ? callerName.charAt(0).toUpperCase() : "U"}
              </AvatarFallback>
            </Avatar>
          </div>
          <AlertDialogTitle className="text-2xl font-semibold">
            Incoming {isAudioOnly ? "Audio" : "Video"} Call
          </AlertDialogTitle>
          <AlertDialogDescription className="text-muted-foreground">
            {callerName || "Someone"} is calling you.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="grid grid-cols-2 gap-3 pt-6">
          <Button
            variant="destructive"
            onClick={handleReject}
            className="w-full py-3 text-base"
            aria-label="Reject call"
          >
            <Phone className="mr-2 h-5 w-5 transform rotate-[135deg]" /> {/* Rotated for hang up look */}
            Reject
          </Button>
          <Button
            variant="default"
            onClick={handleAccept}
            className="w-full py-3 text-base bg-green-600 hover:bg-green-700 text-white"
            aria-label="Accept call"
          >
            {isAudioOnly ? (
              <Phone className="mr-2 h-5 w-5" />
            ) : (
              <Video className="mr-2 h-5 w-5" />
            )}
            Accept
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
