import { useContext } from 'react';
import { SocketContext, SocketContextValue } from './SocketContext';

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
