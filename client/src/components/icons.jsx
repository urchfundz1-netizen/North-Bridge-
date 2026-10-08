/**
 * Inline icon set.
 *
 * Icons are components rather than an icon-font or SVG-sprite request so they
 * inherit `currentColor` and add no extra network round trip. All of them use
 * a 24x24 viewBox and `stroke-width: 1.75` to stay visually consistent with
 * the interface's medium-weight type.
 */

const base = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
  focusable: 'false',
};

function Icon({ children, size = 20, filled = false, ...rest }) {
  return (
    <svg {...base} {...(filled ? { fill: 'currentColor', stroke: 'none' } : {})} width={size} height={size} {...rest}>
      {children}
    </svg>
  );
}

export const IconHome = (p) => (
  <Icon {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.8V20a1 1 0 0 0 1 1h3.5v-5.5h5V21H18a1 1 0 0 0 1-1V9.8" />
  </Icon>
);

export const IconTransfer = (p) => (
  <Icon {...p}>
    <path d="M4 8h13l-3-3" />
    <path d="M20 16H7l3 3" />
  </Icon>
);

export const IconHistory = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 1.8" />
  </Icon>
);

export const IconWallet = (p) => (
  <Icon {...p}>
    <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H18a1 1 0 0 1 1 1v1.5" />
    <path d="M3 8.5V18a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-2.5" />
    <path d="M21 10.5h-4a2.5 2.5 0 0 0 0 5h4a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1Z" />
  </Icon>
);

export const IconReceipt = (p) => (
  <Icon {...p}>
    <path d="M6 3h12v18l-2.5-1.5L13 21l-2.5-1.5L8 21l-2-1.5V3Z" />
    <path d="M9 8h6M9 12h6" />
  </Icon>
);

export const IconUser = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20c1.2-3.4 3.9-5 7-5s5.8 1.6 7 5" />
  </Icon>
);

export const IconUsers = (p) => (
  <Icon {...p}>
    <circle cx="9" cy="9" r="3.2" />
    <path d="M3 19c1-2.9 3.3-4.4 6-4.4s5 1.5 6 4.4" />
    <path d="M16 6.4a3.2 3.2 0 0 1 0 6.2" />
    <path d="M17.5 14.9c2.2.5 3.7 1.9 4.5 4.1" />
  </Icon>
);

export const IconShield = (p) => (
  <Icon {...p}>
    <path d="M12 3 5 6v5.5c0 4 2.9 7.6 7 9.5 4.1-1.9 7-5.5 7-9.5V6l-7-3Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Icon>
);

export const IconLock = (p) => (
  <Icon {...p}>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </Icon>
);

export const IconChart = (p) => (
  <Icon {...p}>
    <path d="M4 20V4" />
    <path d="M4 20h16" />
    <path d="M8 17v-5" />
    <path d="M12.5 17V8" />
    <path d="M17 17v-7" />
  </Icon>
);

export const IconBank = (p) => (
  <Icon {...p}>
    <path d="M3 9.5 12 5l9 4.5" />
    <path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8" />
    <path d="M3 20.5h18" />
  </Icon>
);

export const IconList = (p) => (
  <Icon {...p}>
    <path d="M8 6.5h12M8 12h12M8 17.5h12" />
    <path d="M4 6.5h.01M4 12h.01M4 17.5h.01" />
  </Icon>
);

export const IconSearch = (p) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Icon>
);

export const IconArrowLeft = (p) => (
  <Icon {...p}>
    <path d="M19 12H5" />
    <path d="m11 6-6 6 6 6" />
  </Icon>
);

export const IconArrowRight = (p) => (
  <Icon {...p}>
    <path d="M5 12h14" />
    <path d="m13 6 6 6-6 6" />
  </Icon>
);

export const IconChevronDown = (p) => (
  <Icon {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </Icon>
);

export const IconCheck = (p) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const IconCheckCircle = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12.2 2.4 2.4 4.6-4.8" />
  </Icon>
);

export const IconX = (p) => (
  <Icon {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Icon>
);

export const IconPlus = (p) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconAlert = (p) => (
  <Icon {...p}>
    <path d="M12 4.5 21 19.5H3L12 4.5Z" />
    <path d="M12 10v4" />
    <path d="M12 16.8h.01" />
  </Icon>
);

export const IconInfo = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </Icon>
);

export const IconDownload = (p) => (
  <Icon {...p}>
    <path d="M12 4v11" />
    <path d="m7.5 11 4.5 4.5 4.5-4.5" />
    <path d="M4.5 19.5h15" />
  </Icon>
);

export const IconPrint = (p) => (
  <Icon {...p}>
    <path d="M7.5 9V4.5h9V9" />
    <rect x="4" y="9" width="16" height="7" rx="2" />
    <path d="M7.5 14h9v5.5h-9z" />
  </Icon>
);

export const IconCamera = (p) => (
  <Icon {...p}>
    <path d="M3.5 8.5h3l1.5-2.5h8l1.5 2.5h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-18a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z" />
    <circle cx="12" cy="13.5" r="3.2" />
  </Icon>
);

export const IconSettings = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M18 6l-1.4 1.4M7.4 16.6 6 18M18 18l-1.4-1.4M7.4 7.4 6 6" />
  </Icon>
);

export const IconLogOut = (p) => (
  <Icon {...p}>
    <path d="M14 4.5H7a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 7 19.5h7" />
    <path d="M17 8.5 20.5 12 17 15.5" />
    <path d="M20.5 12H10" />
  </Icon>
);

export const IconInbox = (p) => (
  <Icon {...p}>
    <path d="M4 13.5 6 5.5h12l2 8" />
    <path d="M4 13.5h4l1 2.5h6l1-2.5h4v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5Z" />
  </Icon>
);

export const IconEye = (p) => (
  <Icon {...p}>
    <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </Icon>
);

export const IconSparkle = (p) => (
  <Icon {...p}>
    <path d="M12 4.5 13.6 9 18 10.5 13.6 12 12 16.5 10.4 12 6 10.5 10.4 9 12 4.5Z" />
  </Icon>
);

export const IconMenu = (p) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const IconGlobe = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path d="M12 3.5c2.35 2.4 3.55 5.25 3.55 8.5S14.35 18.1 12 20.5c-2.35-2.4-3.55-5.25-3.55-8.5S9.65 5.9 12 3.5Z" />
  </Icon>
);
