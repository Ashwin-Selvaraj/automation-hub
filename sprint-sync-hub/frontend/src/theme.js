/**
 * Design tokens — Makkal Saatchi-inspired palette.
 * Primary: deep navy (#0D2166) — the same authoritative navy used across
 * the Makkal Saatchi identity for buttons, active states, and headings.
 * Accent blues, status colours, and gray scale complete the system.
 */
export const theme = {
  colors: {
    white:   '#FFFFFF',
    gray50:  '#F9FAFB',
    gray100: '#F3F4F6',
    gray200: '#E5E7EB',
    gray300: '#D1D5DB',
    gray400: '#9CA3AF',
    gray600: '#4B5563',
    gray700: '#374151',
    gray900: '#111827',

    // Makkal Saatchi primary — deep civic navy
    blue600: '#0D2166',
    blue700: '#091852',   // hover / pressed
    blue50:  '#EEF2FF',   // selected row, tint backgrounds

    // Medium blue for links and secondary accents
    linkBlue: '#2563EB',

    // Category tint palette (mirrors Makkal Saatchi category card colours)
    tintBlue:   { bg: '#EEF2FF', text: '#0D2166', border: '#C7D2FE' },
    tintGreen:  { bg: '#F0FDF4', text: '#15803D', border: '#86EFAC' },
    tintAmber:  { bg: '#FFFBEB', text: '#B45309', border: '#FDE68A' },
    tintRed:    { bg: '#FEF2F2', text: '#DC2626', border: '#FECACA' },
    tintPurple: { bg: '#F5F3FF', text: '#6D28D9', border: '#DDD6FE' },
    tintOrange: { bg: '#FFF7ED', text: '#C2410C', border: '#FDBA74' },

    // Semantic status colours
    green600: '#16A34A',
    green50:  '#F0FDF4',

    amber600: '#D97706',
    amber50:  '#FFFBEB',

    red600: '#DC2626',
    red50:  '#FEF2F2',
  },

  fonts: {
    body: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    mono: "'JetBrains Mono', monospace",
  },

  radius: {
    sm: 4,
    md: 6,
    lg: 8,
  },

  shadows: {
    card:     '0 1px 3px rgba(0,0,0,0.08)',
    dropdown: '0 4px 12px rgba(0,0,0,0.12)',
  },
};

// ─── Shared style helpers ─────────────────────────────────────────────────────

export const styles = {
  pageTitle: {
    fontSize: 22,
    fontWeight: 700,
    color: theme.colors.blue600,      // headings in Makkal Saatchi navy
    fontFamily: theme.fonts.body,
    lineHeight: 1.3,
  },
  subtitle: {
    fontSize: 14,
    color: theme.colors.gray400,
    fontFamily: theme.fonts.body,
    marginTop: 4,
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: 600,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    paddingBottom: 10,
    borderBottom: '1px solid #F3F4F6',
    marginBottom: 16,
    fontFamily: theme.fonts.body,
  },
  monoSm: {
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    color: theme.colors.gray400,
  },
  aiBox: {
    background: theme.colors.gray50,
    border: `1px solid ${theme.colors.gray200}`,
    borderLeft: `3px solid ${theme.colors.blue600}`,
    borderRadius: '0 6px 6px 0',
    padding: '12px 16px',
    fontFamily: theme.fonts.mono,
    fontSize: 13,
    color: theme.colors.gray700,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  divider: {
    height: 1,
    background: theme.colors.gray100,
    border: 'none',
    margin: '20px 0',
  },
};
