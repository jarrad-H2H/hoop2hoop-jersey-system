// FILE: src/components/ui/Skeleton.tsx
import React from "react";

/** A single pulsing placeholder bar. */
export const SkeletonBar: React.FC<{ className?: string }> = ({ className = "h-4 w-full" }) => (
  <div className={`animate-pulse rounded bg-gray-200 ${className}`} />
);

/** A table-shaped loading placeholder -- rows x cols of pulsing bars. */
export const SkeletonTable: React.FC<{ rows?: number; cols?: number }> = ({
  rows = 5,
  cols = 5,
}) => (
  <div className="bg-white rounded-lg shadow overflow-hidden">
    <div className="p-3 border-b bg-gray-50">
      <SkeletonBar className="h-3 w-32" />
    </div>
    <div className="divide-y divide-gray-100">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3">
          {Array.from({ length: cols }).map((_, c) => (
            <SkeletonBar key={c} className="h-3 flex-1" />
          ))}
        </div>
      ))}
    </div>
  </div>
);

/** A row of card-shaped loading placeholders, e.g. for summary stat tiles. */
export const SkeletonCards: React.FC<{ count?: number }> = ({ count = 4 }) => (
  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="border border-gray-200 rounded p-3 bg-white">
        <SkeletonBar className="h-3 w-20 mb-2" />
        <SkeletonBar className="h-6 w-12" />
      </div>
    ))}
  </div>
);
