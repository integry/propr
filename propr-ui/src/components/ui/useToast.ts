import { createContext, useContext } from 'react';

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning' | 'undo';
  message: string;
  duration?: number;
  onUndo?: () => void;
}

export interface ToastContextType {
  addToast: (toast: Omit<Toast, 'id'>) => string;
  removeToast: (id: string) => void;
}

export const ToastContext = createContext<ToastContextType | null>(null);

/** The toast actions, or null outside a ToastProvider (isolated component tests). */
export const useOptionalToast = (): ToastContextType | null => useContext(ToastContext);

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};
