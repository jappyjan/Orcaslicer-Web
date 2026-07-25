/**
 * The icon set, inline.
 *
 * Nineteen paths rather than an icon package: the whole set below is about 3 kB of JSX
 * against 40–200 kB for a library, and every glyph here has to carry a caption anyway
 * (see `ToolButton` — an icon on its own is undiscoverable without a tooltip, and a
 * tooltip needs a pointer this app does not assume). They are drawn on a 24-unit grid
 * with `currentColor` strokes so a button's disabled and selected states need no icon
 * variants.
 */

import type { SVGProps } from 'react';

export type IconName =
  | 'add'
  | 'move'
  | 'rotate'
  | 'scale'
  | 'duplicate'
  | 'delete'
  | 'arrange'
  | 'layFlat'
  | 'orbit'
  | 'top'
  | 'fit'
  | 'layers'
  | 'cube'
  | 'slice'
  | 'settings'
  | 'chevronUp'
  | 'chevronDown'
  | 'download'
  | 'close';

const PATHS: Record<IconName, string> = {
  // A plate with a plus over it.
  add: 'M12 5v14M5 12h14',
  // Four arrows from a centre: the move handles a phone cannot have.
  move: 'M12 3v18M3 12h18M12 3 9 6m3-3 3 3M12 21l-3-3m3 3 3-3M3 12l3-3m-3 3 3 3M21 12l-3-3m3 3-3 3',
  rotate: 'M20 12a8 8 0 1 1-2.6-5.9M20 3v5h-5',
  scale: 'M4 15v5h5M20 9V4h-5M9.5 14.5 4 20M14.5 9.5 20 4M4 9V4h5M20 15v5h-5',
  duplicate: 'M9 9h10v10H9zM5 15H4V5h10v1',
  delete: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  // Three boxes settling into a row.
  arrange: 'M4 20h16M6 4h5v6H6zM14 8h4v4h-4zM6 13h5v4H6z',
  layFlat: 'M4 19h16M7 15h10l-2-8H9zM4 19l3-4M20 19l-3-4',
  orbit: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M4 12h16M12 4c2.5 2.2 2.5 13.8 0 16',
  top: 'M12 3 4 8v8l8 5 8-5V8zM4 8l8 5 8-5M12 13v8',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M9 9h6v6H9z',
  layers: 'M12 3 3 8l9 5 9-5zM3 13l9 5 9-5M3 18l9 5 9-5',
  cube: 'M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  slice: 'M4 17h16M6 13l6-9 6 9M9 13v4M15 13v4',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  chevronUp: 'm6 15 6-6 6 6',
  chevronDown: 'm6 9 6 6 6-6',
  download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
  close: 'M6 6l12 12M18 6 6 18',
};

export function Icon({
  name,
  size = 22,
  ...rest
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
