import React from 'react';
import { AlertProps } from './types';

const Alert: React.FC<AlertProps> = ({ message, type }) => {
  const styles = type === 'error'
    ? 'bg-red-50 border-red-200 text-red-700'
    : 'bg-green-50 border-green-200 text-green-700';

  return (
    <div className={`mb-4 p-4 border rounded-md ${styles}`}>
      {message}
    </div>
  );
};

export default Alert;
