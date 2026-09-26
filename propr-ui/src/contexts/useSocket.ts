import { useContext } from 'react';
import { SocketContext, SocketContextValue } from './SocketContext';

/**
 * The socket context when a provider is mounted, and null when one is not.
 *
 * Shell-level providers are also rendered in trees that never construct a
 * socket. They fall back to the disconnected contract - one read, then interval
 * polling - instead of taking the surface down.
 */
export const useOptionalSocket = (): SocketContextValue | null => useContext(SocketContext);

/**
 * Hook to access the socket context
 * Must be used within a SocketProvider
 */
export const useSocket = (): SocketContextValue => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
};
