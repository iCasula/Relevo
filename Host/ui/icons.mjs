// Line icons standing in for the SF Symbols the Mac app uses (one table, keyed by the SF name). 24×24 viewBox,
// drawn with currentColor so they follow the text colour.
import { LOGO_SVG } from './logos.mjs';

const P = {
  'square.and.pencil': '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
  'folder': '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z"/>',
  'folder.badge.plus': '<path d="M12.5 20h-8A1.5 1.5 0 0 1 3 18.5v-12A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7V12"/><path d="M18 15v6M15 18h6"/>',
  'chevron.right': '<path d="m9 6 6 6-6 6"/>',
  'chevron.down': '<path d="m6 9 6 6 6-6"/>',
  'chevron.up': '<path d="m6 15 6-6 6 6"/>',
  'chevron.up.chevron.down': '<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>',
  'chart.bar.xaxis': '<path d="M3 20h18"/><path d="M6 16v-5M10 16V6M14 16v-8M18 16v-3"/>',
  'arrow.clockwise': '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
  'gearshape': '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
  'rectangle.compress.vertical': '<path d="M4 3h16M4 21h16"/><path d="m8 8 4 4 4-4M8 16l4-4 4 4"/>',
  'rectangle.expand.vertical': '<path d="M4 3h16M4 21h16"/><path d="m8 10 4-4 4 4M8 14l4 4 4-4"/>',
  'list.bullet.clipboard': '<rect x="8" y="2.5" width="8" height="4" rx="1"/><path d="M16 4.5h1.5A1.5 1.5 0 0 1 19 6v14a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V6a1.5 1.5 0 0 1 1.5-1.5H8"/><path d="M11 11h4M11 16h4M8.5 11h.01M8.5 16h.01"/>',
  'arrow.triangle.branch': '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11 8.5"/>',
  'square.stack.3d.down.right': '<rect x="3" y="3" width="13" height="13" rx="2"/><path d="M8 21h11a2 2 0 0 0 2-2V8"/>',
  'play.rectangle': '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="m10 9 5 3-5 3Z"/>',
  'gearshape.arrow.triangle.2.circlepath': '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/><circle cx="12" cy="12" r="2.5"/>',
  'person.3.sequence': '<circle cx="5" cy="9" r="2.3"/><circle cx="12" cy="7.5" r="2.3"/><circle cx="19" cy="9" r="2.3"/><path d="M1.5 18a3.5 3.5 0 0 1 7 0M8.5 16.5a3.5 3.5 0 0 1 7 0M15.5 18a3.5 3.5 0 0 1 7 0"/>',
  'person.3.sequence.fill': '<circle cx="5" cy="9" r="2.3" fill="currentColor"/><circle cx="12" cy="7.5" r="2.3" fill="currentColor"/><circle cx="19" cy="9" r="2.3" fill="currentColor"/><path d="M1.5 18a3.5 3.5 0 0 1 7 0M8.5 16.5a3.5 3.5 0 0 1 7 0M15.5 18a3.5 3.5 0 0 1 7 0"/>',
  'arrow.triangle.swap': '<path d="m16 3 4 4-4 4"/><path d="M20 7H6"/><path d="m8 21-4-4 4-4"/><path d="M4 17h14"/>',
  'arrow.up': '<path d="M12 19V5M6 11l6-6 6 6"/>',
  'arrow.down': '<path d="M12 5v14M6 13l6 6 6-6"/>',
  'stop.fill': '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  'bolt.fill': '<path d="M13 2 4 14h7l-1 8 9-12h-7Z" fill="currentColor" stroke="none"/>',
  'text.append': '<path d="M4 6h16M4 11h10M4 16h7M17 14v6M14 17h6"/>',
  'brain': '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1Z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
  'hand.raised': '<path d="M18 11V6a1.5 1.5 0 0 0-3 0v4M15 10V4.5a1.5 1.5 0 0 0-3 0V10M12 9.5V5.5a1.5 1.5 0 0 0-3 0V13"/><path d="M18 8a1.5 1.5 0 0 1 3 0v6a8 8 0 0 1-8 8h-1a7 7 0 0 1-5.6-2.8L3.2 15a1.6 1.6 0 0 1 2.5-2L9 16"/>',
  'hand.raised.fill': '<path d="M18 11V6a1.5 1.5 0 0 0-3 0v4M15 10V4.5a1.5 1.5 0 0 0-3 0V10M12 9.5V5.5a1.5 1.5 0 0 0-3 0V13"/><path d="M18 8a1.5 1.5 0 0 1 3 0v6a8 8 0 0 1-8 8h-1a7 7 0 0 1-5.6-2.8L3.2 15a1.6 1.6 0 0 1 2.5-2L9 16"/>',
  'pencil.line': '<path d="M3 21h18"/><path d="M15.5 4.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
  'bolt.shield': '<path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/><path d="m13 7-3 5h4l-3 5"/>',
  'checkmark.shield': '<path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  'terminal': '<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="m7 10 3 2-3 2M12.5 15h4"/>',
  'pencil': '<path d="M15.5 4.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
  'doc.text': '<path d="M14 2.5H6.5A1.5 1.5 0 0 0 5 4v16a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 20V7.5Z"/><path d="M14 2.5v5h5M9 13h6M9 17h6"/>',
  'magnifyingglass': '<circle cx="11" cy="11" r="6.5"/><path d="m20.5 20.5-4.8-4.8"/>',
  'globe': '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  'person.2': '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14a6.5 6.5 0 0 1 3 6"/>',
  'checklist': '<path d="m3.5 6 1.5 1.5L8 4.5M3.5 13l1.5 1.5L8 11.5M11 6h10M11 13h10M11 19.5h10M4 19.5h3"/>',
  'puzzlepiece.extension': '<path d="M14 4a2 2 0 1 0-4 0v1H6a1 1 0 0 0-1 1v4h1a2 2 0 1 1 0 4H5v4a1 1 0 0 0 1 1h4v-1a2 2 0 1 1 4 0v1h4a1 1 0 0 0 1-1v-4h1a2 2 0 1 0 0-4h-1V6a1 1 0 0 0-1-1h-4Z"/>',
  'wrench.and.screwdriver': '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8"/><path d="M3 21l6-6M5 3 3 5l4 4 2-2Z"/>',
  'checkmark': '<path d="m5 12.5 4.5 4.5L19 7"/>',
  'checkmark.circle.fill': '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m7.5 12.3 3 3 6-6" stroke="var(--canvas)" stroke-width="2.2"/>',
  'checkmark.circle': '<circle cx="12" cy="12" r="9.5"/><path d="m7.5 12.3 3 3 6-6"/>',
  'xmark': '<path d="M6 6l12 12M18 6 6 18"/>',
  'xmark.circle.fill': '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m8.5 8.5 7 7m0-7-7 7" stroke="var(--canvas)" stroke-width="2.2"/>',
  'xmark.circle': '<circle cx="12" cy="12" r="9.5"/><path d="m8.5 8.5 7 7m0-7-7 7"/>',
  'exclamationmark.circle.fill': '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M12 7v6M12 16.5v.5" stroke="var(--canvas)" stroke-width="2.4"/>',
  'exclamationmark.triangle.fill': '<path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" fill="currentColor" stroke="none"/><path d="M12 9v4.5M12 17v.4" stroke="var(--canvas)" stroke-width="2.2"/>',
  'exclamationmark.triangle': '<path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4.5M12 17v.4"/>',
  'hourglass': '<path d="M6 2.5h12M6 21.5h12M7 2.5c0 5 10 5 10 9.5S7 16.5 7 21.5M17 2.5c0 5-10 5-10 9.5s10 4.5 10 9.5"/>',
  'clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  'wand.and.stars': '<path d="m3 21 12-12M14 3v3M19.5 4.5l-2 2M21 10h-3M5 4v2M4 5h2M19 15v2M18 16h2"/><path d="m13 7 4 4"/>',
  'info.circle': '<circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5v.5"/>',
  'arrow.triangle.merge': '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10M6 7c0 4 6 5 10 5"/>',
  'arrow.triangle.pull': '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M18 17V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2"/>',
  'doc.badge.ellipsis': '<path d="M13 2.5H6.5A1.5 1.5 0 0 0 5 4v16a1.5 1.5 0 0 0 1.5 1.5H11"/><path d="M13 2.5v5h5V11"/><circle cx="14" cy="18" r=".6" fill="currentColor"/><circle cx="17" cy="18" r=".6" fill="currentColor"/><circle cx="20" cy="18" r=".6" fill="currentColor"/>',
  'doc.on.doc': '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"/>',
  'photo': '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="9.5" r="1.8"/><path d="m21 16-5-5-9 9"/>',
  'trash': '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13.5h9l1-13.5M10 11v6M14 11v6"/>',
  'plus': '<path d="M12 5v14M5 12h14"/>',
  'minus': '<path d="M5 12h14"/>',
  'minus.circle': '<circle cx="12" cy="12" r="9.5"/><path d="M8 12h8"/>',
  'person.badge.key': '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 9.5-5.8"/><circle cx="17" cy="14" r="2.5"/><path d="M17 16.5v5M17 19h2"/>',
  'key': '<circle cx="8" cy="15" r="4.5"/><path d="m11.3 11.7 9.2-9.2M17 6l3 3M14.5 8.5l2 2"/>',
  'sidebar.left': '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16M5.5 8h1.5M5.5 11h1.5"/>',
  'bubble.left.and.text.bubble.right': '<path d="M3 5.5A2.5 2.5 0 0 1 5.5 3h8A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H8l-3.5 3v-3A2.5 2.5 0 0 1 3 10.5Z"/><path d="M18.5 8.5A2.5 2.5 0 0 1 21 11v4.5a2.5 2.5 0 0 1-1.5 2.3V21l-3.5-3h-4A2.5 2.5 0 0 1 9.5 15.5"/><path d="M6.5 7.5h6M6.5 10h4"/>',
  'person.crop.circle.badge.checkmark': '<circle cx="11" cy="11" r="8.5"/><circle cx="11" cy="9" r="3"/><path d="M5.5 17.5a6 6 0 0 1 11 0"/><path d="m16.5 19.5 2 2 3.5-4"/>',
  'person.crop.circle.badge.exclamationmark': '<circle cx="11" cy="11" r="8.5"/><circle cx="11" cy="9" r="3"/><path d="M5.5 17.5a6 6 0 0 1 11 0M20 15v4M20 21.5v.2"/>',
  'person.2.crop.square.stack': '<rect x="4" y="6" width="16" height="15" rx="3"/><path d="M7 3h10"/><circle cx="9.5" cy="12" r="2"/><circle cx="14.5" cy="12" r="2"/><path d="M6.5 18.5a3 3 0 0 1 6 0M11.5 18.5a3 3 0 0 1 6 0"/>',
  'iphone.gen3': '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 5h3"/>',
  'pause.circle': '<circle cx="12" cy="12" r="9.5"/><path d="M10 8.5v7M14 8.5v7"/>',
  'creditcard.trianglebadge.exclamationmark': '<rect x="2.5" y="5" width="19" height="13" rx="2"/><path d="M2.5 9.5h19M15 21h6M18 14v4"/>',
  'point.topleft.down.to.point.bottomright.curvepath': '<circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M5 7c0 8 14 2 14 10"/>',
  'arrow.triangle.2.circlepath': '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5"/>',
  'questionmark.bubble.fill': '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2h11A2.5 2.5 0 0 1 20 4.5v10a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 4V17h-1A2.5 2.5 0 0 1 4 14.5Z" fill="currentColor" stroke="none"/><path d="M10 8a2 2 0 1 1 2.8 1.8c-.6.3-.8.7-.8 1.2M12 13.8v.2" stroke="var(--canvas)" stroke-width="1.8"/>',
  'circle': '<circle cx="12" cy="12" r="8.5"/>',
  'largecircle.fill.circle': '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5" fill="currentColor"/>',
  'square': '<rect x="4" y="4" width="16" height="16" rx="3"/>',
  'checkmark.square.fill': '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5" fill="currentColor" stroke="none"/><path d="m7.5 12.3 3 3 6-6" stroke="var(--canvas)" stroke-width="2.2"/>',
  'text.bubble': '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 4v-4h-1A2.5 2.5 0 0 1 4 13.5Z"/><path d="M8 8h8M8 11.5h5"/>',
  'text.bubble.fill': '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 4v-4h-1A2.5 2.5 0 0 1 4 13.5Z" fill="currentColor" stroke="none"/>',
  'arrow.uturn.backward': '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  'arrow.up.right.square': '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 15l6-6M10 9h5v5"/>',
  'slider.horizontal.3': '<path d="M3 6h11M18 6h3M3 12h4M11 12h10M3 18h13M20 18h1"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  'crown.fill': '<path d="m3 8 4.5 4L12 5l4.5 7L21 8l-2 11H5Z" fill="currentColor" stroke="none"/>',
  'xmark.octagon': '<path d="M8 2.5h8L21.5 8v8L16 21.5H8L2.5 16V8Z"/><path d="m9 9 6 6m0-6-6 6"/>',
  'sparkles': '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8Z"/><path d="M19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7Z"/>',
  'checkmark.seal': '<path d="M12 2.5l2.4 1.7 2.9-.3 1 2.8 2.5 1.5-.6 2.9 1.3 2.6-2.2 2-.4 2.9-2.9.4-2 2.2-2.6-1.3-2.9.6-1.5-2.5-2.8-1L4 15.4l-1.7-2.4L4 10.6 3.9 7.7l2.8-1 1.5-2.5 2.9.6Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  'dot.radiowaves.left.and.right': '<circle cx="12" cy="12" r="1.8" fill="currentColor"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9.2 9.2 0 0 0 0 13M18.5 5.5a9.2 9.2 0 0 1 0 13"/>',
  'arrow.left.arrow.right.circle': '<circle cx="12" cy="12" r="9.5"/><path d="m8 10 2-2-2-2M8 8h8M16 14l-2 2 2 2M16 16H8"/>',
  'link': '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  'externaldrive': '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 14h.01M10 14h.01"/>',
};

/** An icon for an SF Symbol name; `size` in px (the SF point size). */
export function icon(name, { size = 14, cls = '', title = '' } = {}) {
  const body = P[name] ?? P['circle'];
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${title ? `<title>${title}</title>` : ''}${body}</svg>`;
}

/** Provider badge glyphs (asterisk, hexagon, sparkle…), drawn in white on the tint. */
const GLYPH = {
  asterisk: '<path d="M12 4v16M5.1 8l13.8 8M5.1 16l13.8-8" stroke-width="3"/>',
  hexagon: '<path d="M12 4.5 18.5 8.2v7.6L12 19.5l-6.5-3.7V8.2Z" stroke-width="2.6"/>',
  sparkle: '<path d="M12 3c.7 4.6 3.7 7.9 9 9-5.3 1.1-8.3 4.4-9 9-.7-4.6-3.7-7.9-9-9 5.3-1.1 8.3-4.4 9-9Z" fill="#fff" stroke="none"/>',
  sparkles: '<path d="M12 3c.7 4.6 3.7 7.9 9 9-5.3 1.1-8.3 4.4-9 9-.7-4.6-3.7-7.9-9-9 5.3-1.1 8.3-4.4 9-9Z" fill="#fff" stroke="none"/>',
  fish: '<path d="M3 12c3-4.5 9-6 14-2l4-3v10l-4-3c-5 4-11 2.5-14-2Z" fill="#fff" stroke="none"/>',
  key: '<circle cx="8" cy="15" r="3.5" stroke-width="2.6"/><path d="m10.6 12.4 8-8M16 7l2.5 2.5" stroke-width="2.6"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2" stroke-width="2.6"/>',
};

/** The Mac's ProviderBadge: a rounded square in the provider's tint (gradient) with its symbol in white. */
/** Which real logo a subscription shows (by provider), or null for the tinted glyph. */
export function logoKey(account) {
  const k = account?.kind ?? '';
  if (k === 'claude' || k === 'api:anthropic') return 'claude';
  if (k === 'codex') return 'openai';
  if (k === 'gemini') return 'antigravity';
  if (k === 'acp:gemini') return 'gemini';
  if (/deepseek|dsh/.test(k)) return 'deepseek';
  return null;
}

export function badge(account, size = 16) {
  if (!account) return '';
  const logo = LOGO_SVG[logoKey(account)];
  if (logo) return `<span class="badge-p logo" style="width:${size}px;height:${size}px" title="${(account.name ?? '').replace(/"/g, '&quot;')}"><svg viewBox="0 0 24 24" width="${size * 0.92}" height="${size * 0.92}" ${logo.attrs} xmlns="http://www.w3.org/2000/svg">${logo.body}</svg></span>`;
  const tint = account.tint || '#888';
  const glyph = GLYPH[account.symbol] ?? `<text x="12" y="16.5" font-size="13" font-weight="700" text-anchor="middle" fill="#fff" stroke="none">${(account.name ?? '?')[0]}</text>`;
  return `<span class="badge-p" style="width:${size}px;height:${size}px;border-radius:${size * 0.28}px;background:linear-gradient(180deg, color-mix(in srgb, ${tint} 88%, white), color-mix(in srgb, ${tint} 92%, black))">`
    + `<svg viewBox="0 0 24 24" width="${size * 0.66}" height="${size * 0.66}" fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></span>`;
}

/** The SF symbol of a tool row, by tool name (ToolSummary.symbol on the Mac). */
export function toolSymbol(name = '') {
  const n = name.toLowerCase();
  if (/bash|shell|command|exec|terminal/.test(n)) return 'terminal';
  if (/edit|write|patch|file change|replace/.test(n)) return 'pencil';
  if (/read|view|cat/.test(n)) return 'doc.text';
  if (/grep|glob|search|find|list|ls/.test(n)) return 'magnifyingglass';
  if (/web|fetch|http/.test(n)) return 'globe';
  if (/task|agent/.test(n)) return 'person.2';
  if (/todo|plan/.test(n)) return 'checklist';
  if (/mcp/.test(n)) return 'puzzlepiece.extension';
  return 'wrench.and.screwdriver';
}
