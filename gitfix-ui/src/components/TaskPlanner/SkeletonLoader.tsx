import React from 'react';
import { motion } from 'framer-motion';

interface SkeletonLoaderProps {
  count?: number;
}

const SkeletonCard: React.FC<{ delay?: number }> = ({ delay = 0 }) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay }}
      className="bg-white border border-gray-200 rounded-xl overflow-hidden ml-8"
    >
      {/* Header Section */}
      <div className="p-6 pb-4">
        <div className="flex items-start gap-3 mb-4">
          <div className="mt-1 p-1.5 bg-blue-50 rounded-md">
            <motion.div
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
              className="w-[18px] h-[18px] bg-blue-200 rounded"
            />
          </div>
          <div className="flex-1 space-y-3">
            {/* Title skeleton */}
            <motion.div
              animate={{ opacity: [0.5, 0.8, 0.5] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: 0.1 }}
              className="h-6 bg-gray-200 rounded w-3/4"
            />
            {/* Context label */}
            <motion.div
              animate={{ opacity: [0.4, 0.6, 0.4] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: 0.2 }}
              className="h-3 bg-gray-100 rounded w-16"
            />
            {/* Context lines */}
            <div className="space-y-2">
              <motion.div
                animate={{ opacity: [0.5, 0.8, 0.5] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: 0.3 }}
                className="h-4 bg-gray-200 rounded w-full"
              />
              <motion.div
                animate={{ opacity: [0.5, 0.8, 0.5] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: 0.4 }}
                className="h-4 bg-gray-200 rounded w-5/6"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Implementation Section */}
      <div className="bg-slate-50 border-t border-gray-100 p-6 pt-4">
        <div className="flex items-start gap-3">
          <div className="mt-1 p-1.5 bg-slate-200 rounded-md">
            <motion.div
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: 0.2 }}
              className="w-[16px] h-[16px] bg-slate-300 rounded"
            />
          </div>
          <div className="flex-1 space-y-2">
            <motion.div
              animate={{ opacity: [0.4, 0.6, 0.4] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: 0.3 }}
              className="h-3 bg-slate-200 rounded w-32"
            />
            <div className="space-y-2">
              <motion.div
                animate={{ opacity: [0.5, 0.8, 0.5] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: 0.5 }}
                className="h-4 bg-slate-200 rounded w-full"
              />
              <motion.div
                animate={{ opacity: [0.5, 0.8, 0.5] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: 0.6 }}
                className="h-4 bg-slate-200 rounded w-4/5"
              />
              <motion.div
                animate={{ opacity: [0.5, 0.8, 0.5] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: 0.7 }}
                className="h-4 bg-slate-200 rounded w-2/3"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Notes Section */}
      <div className="bg-yellow-50/50 border-t border-yellow-100/50 p-4">
        <div className="flex items-start gap-3">
          <div className="mt-1 p-1.5">
            <motion.div
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: 0.4 }}
              className="w-[16px] h-[16px] bg-yellow-200 rounded"
            />
          </div>
          <div className="flex-1 space-y-2">
            <motion.div
              animate={{ opacity: [0.4, 0.6, 0.4] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: 0.5 }}
              className="h-3 bg-yellow-100 rounded w-20"
            />
            <motion.div
              animate={{ opacity: [0.4, 0.6, 0.4] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: 0.6 }}
              className="h-4 bg-yellow-100 rounded w-1/2"
            />
          </div>
        </div>
      </div>
    </motion.div>
  );
};

export const SkeletonLoader: React.FC<SkeletonLoaderProps> = ({ count = 3 }) => {
  return (
    <div className="flex h-full">
      {/* Timeline skeleton */}
      <div className="w-16 flex-shrink-0 p-4">
        <div className="flex flex-col items-center gap-4">
          {Array.from({ length: count }).map((_, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: [0.4, 0.7, 0.4], scale: 1 }}
              transition={{
                opacity: { duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: i * 0.1 },
                scale: { duration: 0.3, delay: i * 0.1 }
              }}
              className="w-8 h-8 bg-gray-200 rounded-full"
            />
          ))}
        </div>
      </div>

      {/* Cards skeleton */}
      <div className="flex-1 p-4 space-y-4">
        {Array.from({ length: count }).map((_, i) => (
          <SkeletonCard key={i} delay={i * 0.15} />
        ))}
      </div>
    </div>
  );
};

export default SkeletonLoader;
