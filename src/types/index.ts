
import type { Timestamp } from 'firebase/firestore';

export interface User {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  isActive?: boolean;
}

export type CallType = 'audio' | 'video';
export type CallStatus = 'completed' | 'missed' | 'declined_by_user' | 'ended' | 'ringing' | 'active' | 'ended_by_caller' | 'ended_by_callee';

export interface Message {
  id: string;
  text: string;
  userId: string; // Can be a system ID for call logs
  userName: string | null; 
  userPhotoURL: string | null;
  timestamp: Timestamp | Date | null; 
  threadId?: string;
  callDetails?: {
    type: CallType;
    duration?: number; // in seconds
    status: CallStatus; // e.g., 'completed', 'missed', 'declined'
    callId: string;
  };
}

// Firestore document structure for /calls/{callId}
export interface CallDocument {
  callerId: string;
  callerName?: string;
  calleeId?: string | null;
  calleeName?: string | null;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  status: CallStatus;
  isAudioOnly: boolean;
  createdAt: Timestamp;
  joinedAt?: Timestamp;
  endedAt?: Timestamp;
}
