import React from 'react';
import { Search } from 'lucide-react';

// Global search has no other touch entry below `md`, where the toolbar and its
// field are hidden. It sits in the ProPR menu's header beside Close, so the
// workspace destinations stay above the fold even with enlarged text.
const MobileMenuSearchButton: React.FC<{ onSearch: () => void }> = ({ onSearch }) => (
  <button
    type="button"
    onClick={onSearch}
    aria-haspopup="dialog"
    aria-label="Search"
    title="Search"
    className="inline-flex h-11 w-11 flex-none items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
  >
    <Search className="h-5 w-5" aria-hidden="true" />
  </button>
);

export default MobileMenuSearchButton;
