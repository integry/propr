import React, { useState } from 'react';
import type { CurrentUser } from '../api/proprTypes';

interface UserAvatarProps {
  user: Pick<CurrentUser, 'id' | 'username' | 'displayName' | 'avatarUrl'>;
  className: string;
  fallbackClassName?: string;
  decorative?: boolean;
  referrerPolicy?: React.ImgHTMLAttributes<HTMLImageElement>['referrerPolicy'];
}

type AvatarPresentationProps = Omit<UserAvatarProps, 'user'> & {
  accessibleName: string;
  initials: string;
};

const AvatarFallback: React.FC<AvatarPresentationProps> = ({
  accessibleName,
  className,
  fallbackClassName = '',
  decorative = false,
  initials,
}) => (
  <div
    className={`${className} ${fallbackClassName}`.trim()}
    {...(decorative
      ? { 'aria-hidden': true }
      : { role: 'img', 'aria-label': accessibleName })}
  >
    <span aria-hidden="true">{initials}</span>
  </div>
);

const LoadableAvatar: React.FC<AvatarPresentationProps & { src: string }> = props => {
  const [failed, setFailed] = useState(false);

  if (failed) return <AvatarFallback {...props} />;

  return (
    <img
      src={props.src}
      alt={props.decorative ? '' : props.accessibleName}
      className={props.className}
      onError={() => setFailed(true)}
      referrerPolicy={props.referrerPolicy}
    />
  );
};

const UserAvatar: React.FC<UserAvatarProps> = ({
  user,
  className,
  fallbackClassName = '',
  decorative = false,
  referrerPolicy,
}) => {
  const accessibleName = `${user.displayName || user.username} avatar`;
  const presentation = {
    accessibleName,
    className,
    fallbackClassName,
    decorative,
    initials: user.username.slice(0, 2).toUpperCase(),
    referrerPolicy,
  };

  if (user.avatarUrl) {
    return (
      <LoadableAvatar
        key={`${user.id}:${user.avatarUrl}`}
        src={user.avatarUrl}
        {...presentation}
      />
    );
  }

  return <AvatarFallback {...presentation} />;
};

export default UserAvatar;
