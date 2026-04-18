// ══════════════════════════════════════════════════════════════════════
// ops.js — canonical EO constants
// Nine operators, the 27-cell map, and helpers for three-face notation.
// ══════════════════════════════════════════════════════════════════════

/**
 * The nine operators in helix order (position = op_code enum).
 * Assignments match the user-confirmed canonical significance triad:
 *   DEF at pos 7 (Diff × Sig · establishes what holds)
 *   EVA at pos 8 (Rel × Sig · renders judgment)
 *   REC at pos 9 (Gen × Sig · restructures the frame)
 */
export const OPS = {
  NUL: { code: 1, glyph: '∅', name: 'Non-transformation', mode: 'Differentiating', domain: 'Existence',    role: 'Ground',  triad: 'Existence',    color: '#8A8175', tint: '#E8E2D6', def: 'State passes through unchanged. Observation without action.' },
  SIG: { code: 2, glyph: '○', name: 'Distinction',        mode: 'Relating',        domain: 'Existence',    role: 'Figure',  triad: 'Existence',    color: '#D4A04A', tint: '#F4E5C5', def: 'Mark this as this-not-that. The first distinction.' },
  INS: { code: 3, glyph: '●', name: 'Instantiation',      mode: 'Generating',      domain: 'Existence',    role: 'Pattern', triad: 'Existence',    color: '#A67423', tint: '#EDD9B4', def: 'Mint a permanent anchor. Create a concrete instance.' },
  SEG: { code: 4, glyph: '｜', name: 'Segmentation',      mode: 'Differentiating', domain: 'Structure',    role: 'Ground',  triad: 'Structure',    color: '#4A9BA7', tint: '#CEE4E8', def: 'Draw a boundary. Partition, filter, group.' },
  CON: { code: 5, glyph: '⤫', name: 'Connection',         mode: 'Relating',        domain: 'Structure',    role: 'Figure',  triad: 'Structure',    color: '#0A7E8C', tint: '#BDDDE2', def: 'Establish a relationship between differentiated entities.' },
  SYN: { code: 6, glyph: '△', name: 'Synthesis',          mode: 'Generating',      domain: 'Structure',    role: 'Pattern', triad: 'Structure',    color: '#065D68', tint: '#ADD0D6', def: 'Produce an emergent whole not reducible to its parts.' },
  DEF: { code: 7, glyph: '⊢', name: 'Definition',         mode: 'Differentiating', domain: 'Significance', role: 'Ground',  triad: 'Significance', color: '#9E7BB8', tint: '#E0D4EB', def: 'Establish what holds. Set a value within a stable frame.' },
  EVA: { code: 8, glyph: '⊨', name: 'Evaluation',         mode: 'Relating',        domain: 'Significance', role: 'Figure',  triad: 'Significance', color: '#7D4F9E', tint: '#D4C4E2', def: 'Render judgment. Resolve conflicts between competing values.' },
  REC: { code: 9, glyph: '⊛', name: 'Recursion',          mode: 'Generating',      domain: 'Significance', role: 'Pattern', triad: 'Significance', color: '#B84A62', tint: '#EFCBD4', def: 'Restructure the frame itself. Schema migration, reframing.' }
};

export const OP_ORDER = ['NUL','SIG','INS','SEG','CON','SYN','DEF','EVA','REC'];
export const OP_BY_CODE = OP_ORDER.reduce((m, k, i) => (m[i+1] = k, m), {});

/** Operators that emit Given-Log entries (SIG and NUL do not). */
export const EMITTING = new Set(['INS','SEG','CON','SYN','DEF','EVA','REC']);

/** Site face (Domain × Object) — the nine terrains. */
export const SITES = {
  'Existence|Ground':    'Void',
  'Existence|Figure':    'Entity',
  'Existence|Pattern':   'Kind',
  'Structure|Ground':    'Field',
  'Structure|Figure':    'Link',
  'Structure|Pattern':   'Network',
  'Significance|Ground': 'Atmosphere',
  'Significance|Figure': 'Lens',
  'Significance|Pattern':'Paradigm'
};

/** Resolution face (Mode × Object) — the nine stances. */
export const RESOLUTIONS = {
  'Differentiating|Ground':  'Clearing',
  'Differentiating|Figure':  'Dissecting',
  'Differentiating|Pattern': 'Severing',
  'Relating|Ground':         'Tempering',
  'Relating|Figure':         'Binding',
  'Relating|Pattern':        'Cultivating',
  'Generating|Ground':       'Seeding',
  'Generating|Figure':       'Forging',
  'Generating|Pattern':      'Weaving'
};

export const SITE_ORDER = ['Void','Entity','Kind','Field','Link','Network','Atmosphere','Lens','Paradigm'];
export const RESOLUTION_ORDER = ['Clearing','Dissecting','Severing','Tempering','Binding','Cultivating','Seeding','Forging','Weaving'];
export const OBJECT_ORDER = ['Ground','Figure','Pattern'];
export const MODE_ORDER = ['Differentiating','Relating','Generating'];
export const DOMAIN_ORDER = ['Existence','Structure','Significance'];

/** The Desert — SYN × Ground — universally empty across tested corpora. */
export const DESERT_CELL = 'SYN|Ground';

export function siteFor(domain, object)      { return SITES[`${domain}|${object}`] || '—'; }
export function resolutionFor(mode, object)  { return RESOLUTIONS[`${mode}|${object}`] || '—'; }

/** Three-face notation: OP(Resolution, Site) — the canonical form. */
export function phasepostNotation(op, mode, domain, object) {
  const res  = resolutionFor(mode, object);
  const site = siteFor(domain, object);
  return `${op}(${res}, ${site})`;
}

/** Encode/decode op_code ↔ name. */
export function opCodeOf(name)   { return OPS[name]?.code || 0; }
export function opNameOf(code)   { return OP_BY_CODE[code] || null; }

/** Encode site and resolution as small enums (1-9) for typed-array indices. */
export function siteCode(site) {
  const i = SITE_ORDER.indexOf(site);
  return i < 0 ? 0 : i + 1;
}
export function resolutionCode(stance) {
  const i = RESOLUTION_ORDER.indexOf(stance);
  return i < 0 ? 0 : i + 1;
}
