// ══════════════════════════════════════════════════════════════════════
// rules.js — deterministic DEF-value resolver
//
// After enough user resolutions converge on a pattern (e.g. "user always
// picks the latest value for financial figures"), the fold worker
// proposes a REC that installs a rule. Once installed, that rule picks
// a winner for competing DEF values deterministically — no model call.
//
// ══════════════════════════════════════════════════════════════════════

import { getAllRules, appendRule, deactivateRule } from './store.js';
import { uuidv7 } from './anchor.js';

/* ═══ Built-in rule implementations ═════════════════════════════════════
   A rule is a strategy name plus a configuration. We keep the strategy
   implementations in JS; only the config is persisted. This keeps the
   store format forward-compatible.
   ═══════════════════════════════════════════════════════════════════════ */

const STRATEGIES = {
  /** "Most recent value wins" for targets matching a type_hint. */
  latestWins: {
    describe: (config) => `latest-wins for targets matching ${config.match || 'any'}`,
    resolve: (values, config) => {
      if (!values.length) return null;
      // Pick the candidate with the newest timestamp
      let bestIdx = 0;
      let bestTs = values[0].timestamp || '';
      for (let i = 1; i < values.length; i++) {
        if ((values[i].timestamp || '') > bestTs) {
          bestIdx = i;
          bestTs = values[i].timestamp || '';
        }
      }
      return { winnerIndex: bestIdx, reason: 'rule: latest-wins', confidence: 1.0 };
    }
  },
  /** "Highest confidence wins" — prefers the source with the highest stated confidence. */
  highestConfidence: {
    describe: (config) => `highest-confidence for targets matching ${config.match || 'any'}`,
    resolve: (values, config) => {
      if (!values.length) return null;
      let bestIdx = 0;
      let bestConf = values[0].provenance?.confidence ?? 0;
      for (let i = 1; i < values.length; i++) {
        const c = values[i].provenance?.confidence ?? 0;
        if (c > bestConf) { bestIdx = i; bestConf = c; }
      }
      return { winnerIndex: bestIdx, reason: 'rule: highest-confidence', confidence: 1.0 };
    }
  },
  /** "Trusted source wins" — picks the first value whose source is in the trusted set. */
  trustedSource: {
    describe: (config) => `trusted-source ${JSON.stringify(config.sources || [])} for ${config.match || 'any'}`,
    resolve: (values, config) => {
      const trusted = new Set(config.sources || []);
      if (!values.length || !trusted.size) return null;
      for (let i = 0; i < values.length; i++) {
        if (trusted.has(values[i].source)) {
          return { winnerIndex: i, reason: `rule: trusted-source (${values[i].source})`, confidence: 1.0 };
        }
      }
      return null;
    }
  },
  /** "User-pinned" — the target has a manual override the user has chosen. */
  userPinned: {
    describe: (config) => `user-pinned value for ${config.match || 'specific target'}`,
    resolve: (values, config) => {
      if (!values.length) return null;
      // Match the pinned value
      for (let i = 0; i < values.length; i++) {
        if (JSON.stringify(values[i].value) === JSON.stringify(config.pinned_value)) {
          return { winnerIndex: i, reason: 'rule: user-pinned', confidence: 1.0 };
        }
      }
      return null;
    }
  }
};

/* ═══ Rule matching ═══════════════════════════════════════════════════ */

/**
 * Does a rule's `match` filter apply to this target?
 * A match is an object; supported fields:
 *   type_hint   — exact match against target's type_hint
 *   target      — exact anchor hash match
 *   target_prefix — prefix match on the anchor's form
 */
function ruleMatches(rule, targetInfo) {
  const m = rule.match || {};
  if (m.type_hint && targetInfo.type_hint !== m.type_hint) return false;
  if (m.target && targetInfo.hash !== m.target) return false;
  if (m.target_prefix && !String(targetInfo.form || '').startsWith(m.target_prefix)) return false;
  return true;
}

/**
 * Try to resolve competing DEF values using installed rules.
 * Returns { winnerIndex, reason, confidence, ruleId } on success,
 * or null to defer to the model.
 */
export async function tryRules(targetInfo, values, context) {
  const rules = await getAllRules();
  // Sort by priority (highest first), then by installed time (newest first)
  const active = rules
    .filter(r => r.active !== false)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0)
                 || (b.installed_at || '').localeCompare(a.installed_at || ''));
  for (const rule of active) {
    if (!ruleMatches(rule, targetInfo)) continue;
    const strategy = STRATEGIES[rule.strategy];
    if (!strategy) continue;
    const result = strategy.resolve(values, rule.config || {});
    if (result != null) {
      return { ...result, ruleId: rule.id, ruleStrategy: rule.strategy };
    }
  }
  return null;
}

/**
 * Install a new rule from a REC proposal.
 */
export async function installRule({ strategy, match, config, priority, description, installedBy }) {
  if (!STRATEGIES[strategy]) {
    throw new Error(`Unknown rule strategy: ${strategy}`);
  }
  const rule = {
    id: uuidv7(),
    strategy,
    match: match || {},
    config: config || {},
    priority: priority || 0,
    description: description || STRATEGIES[strategy].describe(config || {}),
    active: true,
    installed_at: new Date().toISOString(),
    installed_by: installedBy || 'user'
  };
  await appendRule(rule);
  return rule;
}

/** Mark a rule inactive (not deleted — append-only spirit). */
export async function retireRule(id) {
  await deactivateRule(id);
}

/** List all strategies the UI can offer. */
export function availableStrategies() {
  return Object.keys(STRATEGIES).map(k => ({
    key: k,
    describe: STRATEGIES[k].describe
  }));
}
