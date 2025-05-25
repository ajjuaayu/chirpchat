import type { Timestamp } from 'firebase/firestore';

export interface User {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  isActive?: boolean;
}

export interface Message {
  id: string;
  text: string;
  userId: string;
  userName: string | null; // Changed from displayName to avoid conflict with User.displayName
  userPhotoURL: string | null; // Changed from photoURL
  timestamp: Timestamp | Date | null; // Allow Date for client-side creation before Firestore conversion
  threadId?: string;
}
