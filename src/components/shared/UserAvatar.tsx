import type { User } from '@/types';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

interface UserAvatarProps {
  user?: User | null;
  className?: string;
}

export function UserAvatar({ user, className }: UserAvatarProps) {
  const getInitials = (name?: string | null) => {
    if (!name) return 'U';
    const names = name.split(' ');
    if (names.length > 1 && names[0] && names[names.length -1]) {
      return `${names[0][0]}${names[names.length - 1][0]}`.toUpperCase();
    }
    if (name.length > 1) return name.substring(0, 2).toUpperCase();
    return name[0]?.toUpperCase() || 'U';
  };

  return (
    <Avatar className={cn('h-10 w-10', className)}>
      <AvatarImage src={user?.photoURL || undefined} alt={user?.displayName || 'User Avatar'} />
      <AvatarFallback className="font-medium">
        {getInitials(user?.displayName)}
      </AvatarFallback>
    </Avatar>
  );
}
