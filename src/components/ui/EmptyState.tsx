// FILE: src/components/ui/EmptyState.tsx
import React from "react";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";

const EmptyState: React.FC<{
  icon?: LucideIcon;
  title: string;
  description?: string;
}> = ({ icon: Icon = Inbox, title, description }) => (
  <div className="flex flex-col items-center justify-center text-center py-12 px-4">
    <div className="w-12 h-12 rounded-full bg-brand-50 flex items-center justify-center mb-3">
      <Icon size={22} className="text-brand-400" />
    </div>
    <p className="text-sm font-medium text-gray-700">{title}</p>
    {description && <p className="text-xs text-gray-500 mt-1 max-w-sm">{description}</p>}
  </div>
);

export default EmptyState;
