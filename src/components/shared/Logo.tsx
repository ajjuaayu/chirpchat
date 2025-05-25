import { MessageSquareText } from 'lucide-react';
import Link from 'next/link';

interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
}

export function Logo({ size = 'md' }: LogoProps) {
  const iconSize = size === 'sm' ? 24 : size === 'lg' ? 40 : 32;
  const textSize = size === 'sm' ? 'text-xl' : size === 'lg' ? 'text-3xl' : 'text-2xl';

  return (
    <Link href="/" className="inline-block">
      <div className={`flex items-center gap-2 font-bold text-primary hover:opacity-80 transition-opacity`}>
        <MessageSquareText size={iconSize} strokeWidth={2.5} />
        <span className={textSize}>Chirp Chat</span>
      </div>
    </Link>
  );
}
