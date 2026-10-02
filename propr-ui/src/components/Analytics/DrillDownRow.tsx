/**
 * A table row that opens the filtered list behind it.
 *
 * The whole row is the pointer target: hovering it tints it and clicking
 * anywhere in it follows its link. Keyboard and assistive tech get the same
 * destination from a real link in the row's identity cell, which also keeps
 * middle-click and "open in new tab" working. A link of its own inside the
 * row, such as a failure count, wins over the row's, and a click that ends a
 * text selection selects rather than navigates.
 */

import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

export const DrillDownRow: React.FC<{ to: string; children: React.ReactNode }> = ({ to, children }) => {
  const navigate = useNavigate();
  const onClick = (event: React.MouseEvent<HTMLTableRowElement>) => {
    if ((event.target as Element).closest('a, button')) return;
    if (window.getSelection()?.toString()) return;
    navigate(to);
  };
  return (
    <tr
      onClick={onClick}
      className="group cursor-pointer border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
      data-drill-down={to}
    >
      {children}
    </tr>
  );
};

/**
 * The row's identity cell: the link that names its destination, and the
 * chevron that marks the row as one. The chevron sits in the cell's right
 * padding, so it never takes width from the name.
 */
export const DrillDownCell: React.FC<{ to: string; label: string; className: string; children: React.ReactNode }> = ({
  to, label, className, children,
}) => (
  <td className={`${className} relative min-w-0`}>
    <Link
      to={to}
      aria-label={label}
      className="flex min-w-0 items-center gap-2 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
    >
      {children}
    </Link>
    <ChevronRight
      aria-hidden="true"
      // Phones have too little padding for it; the row is still the tap target.
      className="absolute right-0.5 top-1/2 hidden h-3.5 w-3.5 -translate-y-1/2 text-slate-300 transition-colors group-hover:text-slate-500 sm:block"
    />
  </td>
);
