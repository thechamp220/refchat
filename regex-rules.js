'use strict';
// Règles regex du tableau. Le chat les applique sans IA. Un stockage vide
// veut dire « pas encore personnalisé » : on reprend les défauts.
(function (root) {
  const DEFAULTS = [
    {
      id: 'reg_discord',
      name: 'Liens Discord',
      pattern: '(?:https?:\\/\\/)?(?:www\\.)?(?:discord\\.(?:gg|io|me|li)|discordapp\\.com\\/invite)\\/[a-z0-9_-]+',
      flags: 'i',
      action: 'mute',
      reason: 'Lien Discord non autorisé',
      enabled: true
    },
    {
      id: 'reg_telegram',
      name: 'Liens Telegram / WhatsApp',
      pattern: '(?:https?:\\/\\/)?(?:t\\.me|telegram\\.me|chat\\.whatsapp\\.com)\\/[a-z0-9_-]+',
      flags: 'i',
      action: 'mute',
      reason: 'Lien Telegram/WhatsApp non autorisé',
      enabled: true
    },
    {
      id: 'reg_bots',
      name: 'Promo Bots & Followers',
      pattern: '(?:buy|get|free|cheap)\\s*(?:followers|viewers|subs|views)\\b|(?:bigfollows|viewershub|dogfollowers)\\b',
      flags: 'i',
      action: 'mute',
      reason: 'Promo bot de followers',
      enabled: true
    },
    {
      id: 'reg_caps',
      name: 'Majuscules abusives (All-caps)',
      pattern: '^(?=.{14,}$)(?=(?:[^A-Z]*[A-Z]){10})[^a-z]*$',
      flags: '',
      action: 'review',
      reason: 'Majuscules abusives',
      enabled: true
    },
    {
      id: 'reg_crypto',
      name: 'Arnaques Crypto & Scams',
      pattern: '\\b(?:free\\s*airdrop|claim\\s*tokens?|connect\\s*wallet|crypto\\s*gift|claim\\s*nft)\\b',
      flags: 'i',
      action: 'mute',
      reason: 'Arnaque crypto / scam',
      enabled: true
    }
  ];

  function compile(patternStr, defaultFlags) {
    if (!patternStr || typeof patternStr !== 'string') return null;
    const str = patternStr.trim();
    if (!str) return null;
    try {
      let pattern = str;
      let flags = defaultFlags != null ? String(defaultFlags) : 'i';
      if (str.startsWith('/') && str.lastIndexOf('/') > 0) {
        const lastSlash = str.lastIndexOf('/');
        pattern = str.slice(1, lastSlash);
        flags = str.slice(lastSlash + 1);
      }
      // Migrate the exact old built-in pattern, including saved copies. Its
      // overlapping repetitions could block V8 on a short near-match.
      if (pattern === '^(?=.{14,}$)(?:[^a-z]*[A-Z]){10,}[^a-z]*$') {
        pattern = '^(?=.{14,}$)(?=(?:[^A-Z]*[A-Z]){10})[^a-z]*$';
      }
      // g/y font alterner test() d'un message à l'autre.
      return new RegExp(pattern, flags.replace(/[gy]/g, ''));
    } catch (_) {
      return null;
    }
  }

  function active(stored) {
    if (Array.isArray(stored) && stored.length) return stored;
    return DEFAULTS;
  }

  function match(text, stored) {
    const raw = String(text || '').slice(0, 500);
    if (!raw) return null;
    for (const rule of active(stored)) {
      if (!rule || rule.enabled === false) continue;
      const re = compile(rule.pattern, rule.flags !== undefined ? rule.flags : 'i');
      if (!re) continue;
      re.lastIndex = 0;
      if (re.test(raw)) {
        return {
          action: rule.action === 'review' ? 'review' : 'mute',
          reason: String(rule.reason || rule.name || 'regex').slice(0, 80)
        };
      }
    }
    return null;
  }

  root.CSG_REGEX = Object.freeze({ DEFAULTS, compile, active, match });
})(typeof self !== 'undefined' ? self : globalThis);
