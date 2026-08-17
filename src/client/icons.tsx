/**
 * Shared inline SVG icon set for dsh-devlaunch. Stroke/fill use
 * currentColor so icons inherit the text color of their button and
 * light/dark themes both work with zero extra CSS. All icons live in a
 * 16x16 viewBox and default to 14px.
 *
 * @module dsh-devlaunch/client/icons
 */
import { type ReactNode } from 'react'

/** Icon props. */
export interface IconProps {
  /** Square size in px (default 14). */
  size?: number
  /** Optional class for styling/animation. */
  className?: string
}

/** One svg wrapper. */
function svg(props: IconProps, children: ReactNode): ReactNode {
  const size = props.size ?? 14
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={props.className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** Solid play triangle. */
export function IconPlay(props: IconProps): ReactNode {
  return svg(props, (
    <path
      d="M5 3.2v9.6c0 .55.6.9 1.07.6l7.4-4.8a.7.7 0 0 0 0-1.2L6.07 2.6A.7.7 0 0 0 5 3.2Z"
      fill="currentColor"
    />
  ))
}

/** Solid stop square. */
export function IconStop(props: IconProps): ReactNode {
  return svg(props, <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.6" fill="currentColor" />)
}

/** Circular restart arrow. */
export function IconRestart(props: IconProps): ReactNode {
  return svg(props, (
    <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.82" />
      <path d="M13.6 1.9v2.6h-2.6" />
    </g>
  ))
}

/** Trash bin. */
export function IconTrash(props: IconProps): ReactNode {
  return svg(props, (
    <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.8 4.4h10.4" />
      <path d="M6.4 2.4h3.2" />
      <path d="M4.6 4.4l.5 8.2c.03.55.47.98 1.02.98h3.76c.55 0 .99-.43 1.02-.98l.5-8.2" />
      <path d="M6.6 7v3.8M9.4 7v3.8" />
    </g>
  ))
}

/** Settings gear (sun-gear form, legible at 12-14px). */
export function IconGear(props: IconProps): ReactNode {
  return svg(props, (
    <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.6v1.9M8 12.5v1.9M1.6 8h1.9M12.5 8h1.9M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" />
    </g>
  ))
}

/** Down chevron. */
export function IconChevron(props: IconProps): ReactNode {
  return svg(props, <path d="M4 6.2 8 10l4-3.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />)
}

/** Plus. */
export function IconPlus(props: IconProps): ReactNode {
  return svg(props, <path d="M8 3.4v9.2M3.4 8h9.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />)
}

/** Arrow up. */
export function IconArrowUp(props: IconProps): ReactNode {
  return svg(props, <path d="M8 12.6V3.4M4.4 7 8 3.4 11.6 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />)
}

/** Arrow down. */
export function IconArrowDown(props: IconProps): ReactNode {
  return svg(props, <path d="M8 3.4v9.2M4.4 9 8 12.6 11.6 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />)
}

/** Close X. */
export function IconClose(props: IconProps): ReactNode {
  return svg(props, <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />)
}

/** Copy (two sheets). */
export function IconCopy(props: IconProps): ReactNode {
  return svg(props, (
    <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5.6" y="5.6" width="7" height="7" rx="1.5" />
      <path d="M10.4 5.6V4A1.6 1.6 0 0 0 8.8 2.4H4A1.6 1.6 0 0 0 2.4 4v4.8A1.6 1.6 0 0 0 4 10.4h1.6" />
    </g>
  ))
}

/** Check. */
export function IconCheck(props: IconProps): ReactNode {
  return svg(props, <path d="M3.4 8.6 6.4 11.6 12.6 4.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />)
}

/** Search magnifier. */
export function IconSearch(props: IconProps): ReactNode {
  return svg(props, (
    <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="7" cy="7" r="4.3" />
      <path d="M10.3 10.3 13.6 13.6" />
    </g>
  ))
}

/** Funnel filter. */
export function IconFunnel(props: IconProps): ReactNode {
  return svg(props, <path d="M2.4 3.4h11.2L9.4 8.5v3.7L6.6 13.6V8.5L2.4 3.4Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />)
}

/** Download / import. */
export function IconImport(props: IconProps): ReactNode {
  return svg(props, (
    <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.6v7.2M4.9 7 8 10.1 11.1 7" />
      <path d="M2.8 12.2v.6a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-.6" />
    </g>
  ))
}

/** Terminal box. */
export function IconTerminal(props: IconProps): ReactNode {
  return svg(props, (
    <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="10" rx="1.8" />
      <path d="M4.8 6.1 7 8l-2.2 1.9M8.8 10.3h2.8" />
    </g>
  ))
}

/** Stacked layers (launch presets). */
export function IconLayers(props: IconProps): ReactNode {
  return svg(props, (
    <g stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" fill="none">
      <path d="M8 2.1 14 5.3 8 8.5 2 5.3Z" />
      <path d="M2.6 8.7 8 11.6l5.4-2.9" />
      <path d="M2.6 11.8 8 14.7l5.4-2.9" />
    </g>
  ))
}

/** File export (page with down arrow). */
export function IconExport(props: IconProps): ReactNode {
  return svg(props, (
    <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2.8h5.2L12.4 6v7.2a.9.9 0 0 1-.9.9H4a.9.9 0 0 1-.9-.9V3.7a.9.9 0 0 1 .9-.9Z" />
      <path d="M9 2.9V6h3.3" />
      <path d="M6.6 9.2v3.4M5 11.2l1.6 1.6 1.6-1.6" />
    </g>
  ))
}
