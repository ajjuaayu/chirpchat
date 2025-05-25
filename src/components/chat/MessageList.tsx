"use client";

import { MessageItem } from "@/components/chat/MessageItem";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Message } from "@/types";
import { useEffect, useRef, useState } from "react";
import { collection, query, orderBy, onSnapshot, Timestamp } from "firebase/firestore";
import { firestore } from "@/lib/firebase";
import { Skeleton } from "../ui/skeleton";

export function MessageList() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const messagesRef = collection(firestore, "messages");
    const q = query(messagesRef, orderBy("timestamp", "asc"));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedMessages: Message[] = [];
      snapshot.forEach((doc) => {
        fetchedMessages.push({ id: doc.id, ...doc.data() } as Message);
      });
      setMessages(fetchedMessages);
      setLoading(false);
    }, (error) => {
      console.error("Error fetching messages:", error);
      // Fallback to placeholder messages on error
      setMessages([
        { id: '1', text: 'Hello there!', userId: 'alice', userName: 'Alice', userPhotoURL: 'https://placehold.co/40x40.png', timestamp: Timestamp.now() },
        { id: '2', text: 'Hi Alice! How are you?', userId: 'bob', userName: 'Bob', userPhotoURL: 'https://placehold.co/40x40.png', timestamp: Timestamp.now() },
        { id: '3', text: 'Doing great! Enjoying Chirp Chat. This is a longer message to test wrapping and layout. Hope it looks good on different screen sizes and provides a good user experience.', userId: 'alice', userName: 'Alice', userPhotoURL: 'https://placehold.co/40x40.png', timestamp: Timestamp.now() },
      ]);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    // Auto-scroll to bottom
    if (viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <ScrollArea className="flex-1 bg-background/70" ref={scrollAreaRef}>
      <div className="p-4 space-y-2" ref={viewportRef}>
        {loading && (
          <>
            <div className="flex items-start gap-3 p-3 justify-start">
              <Skeleton className="h-8 w-8 rounded-full mt-1 flex-shrink-0" />
              <div className="flex flex-col items-start max-w-[70%]">
                <Skeleton className="h-16 w-48 rounded-xl" />
                <Skeleton className="h-3 w-20 mt-1" />
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 justify-end">
              <div className="flex flex-col items-end max-w-[70%]">
                <Skeleton className="h-12 w-40 rounded-xl" />
                <Skeleton className="h-3 w-16 mt-1" />
              </div>
              <Skeleton className="h-8 w-8 rounded-full mt-1 flex-shrink-0" />
            </div>
          </>
        )}
        {!loading && messages.map((msg) => (
          <MessageItem key={msg.id} message={msg} />
        ))}
        {!loading && messages.length === 0 && (
            <p className="text-center text-muted-foreground py-10">No messages yet. Start a conversation!</p>
        )}
      </div>
    </ScrollArea>
  );
}
