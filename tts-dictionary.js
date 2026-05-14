/*
 * tts-dictionary.js
 * Abbreviation/unit expansion for Web Speech API TTS.
 * Exposes window.TTS_DICT, window.convertForTTS(text), window.pickPreferredVoice(voices).
 *
 * Add new entries to TTS_DICT. Word-boundary matching is applied so partial
 * tokens like 'SKU' inside 'SKULL' will NOT be replaced.
 */
(function () {
  'use strict';

  var TTS_DICT = {
    // Volume / units
    'HL': 'hectoliters',
    'hl': 'hectoliters',
    'KRW': 'Korean won',
    '₩': ' Korean won ',

    // Common business shorthand
    'SKU': 'skew',
    'SKUs': 'skews',
    'FCST': 'forecast',
    'AP': 'annual plan',
    'RoFo': 'rolling forecast',
    'ROFO': 'rolling forecast',
    'MTD': 'month to date',
    'YTD': 'year to date',
    'WD': 'working day',
    'YoY': 'year over year',
    'MoM': 'month over month',
    'LY': 'last year',
    'LM': 'last month',
    'KPI': 'key performance indicator',
    'KPIs': 'key performance indicators',
    'FLM': 'frontline manager',
    'FLMs': 'frontline managers',
    'WS': 'wholesale',
    'OT': 'on-trade',
    'TM': 'traditional market',
    'NKA': 'national key account',
    'GP': 'gross profit',
    'VPO': 'volume per outlet',
    'MWB': 'must win battle',
    'BSM': 'branch sales manager',
    'OpCo': 'operating company',
    'PICOS': 'picture of success',

    // Brand short codes
    'HE': 'Heineken',
    'TI': 'Tiger',
    'DE': 'Desperados',
    'PA': 'Paulaner',
    'ED': 'Edelweiss',
    'SU': 'Sol',
    'BI': 'Birra',
  };

  // Tokens that include non-word characters (₩, etc.) cannot use \b boundaries.
  // We handle them separately with a simple global replace.
  var SPECIAL_TOKENS = ['₩'];

  function _escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function convertForTTS(text) {
    if (text == null) return '';
    var result = String(text);

    // Special non-word tokens first
    SPECIAL_TOKENS.forEach(function (tok) {
      if (Object.prototype.hasOwnProperty.call(TTS_DICT, tok)) {
        result = result.split(tok).join(TTS_DICT[tok]);
      }
    });

    // Word-boundary replacements for everything else
    Object.keys(TTS_DICT).forEach(function (abbr) {
      if (SPECIAL_TOKENS.indexOf(abbr) !== -1) return;
      var re = new RegExp('\\b' + _escapeRegex(abbr) + '\\b', 'g');
      result = result.replace(re, TTS_DICT[abbr]);
    });

    // Volume units attached to numbers: "33cl" → "33 centiliters", "20L" → "20 liters"
    result = result.replace(/(\d+(?:\.\d+)?)cl\b/g, '$1 centiliters');
    result = result.replace(/(\d+(?:\.\d+)?)L\b/g, '$1 liters');

    // Collapse stray double spaces caused by inserted phrases
    result = result.replace(/[ \t]{2,}/g, ' ').trim();
    return result;
  }

  // Returns the best available en-US voice. Preference order:
  //   1. Microsoft Guy Online (Natural)
  //   2. Microsoft Aria Online (Natural)
  //   3. Any voice whose name contains "Natural" and is en-US
  //   4. Any en-US voice
  //   5. Any English voice
  //   6. First available voice
  function pickPreferredVoice(voices) {
    if (!voices || !voices.length) return null;
    var byName = function (needle) {
      return voices.find(function (v) { return v.name && v.name.indexOf(needle) !== -1; });
    };
    return (
      byName('Guy Online (Natural)') ||
      byName('Aria Online (Natural)') ||
      voices.find(function (v) { return v.name && v.name.indexOf('Natural') !== -1 && v.lang === 'en-US'; }) ||
      voices.find(function (v) { return v.lang === 'en-US'; }) ||
      voices.find(function (v) { return v.lang && v.lang.indexOf('en') === 0; }) ||
      voices[0]
    );
  }

  // ── SKU name humanization ──
  // Turns dashboard codes like "HE ORI 330 Bottle" into "Heineken 33cl Bottle".
  //   - Brand letters expand: HE → Heineken, DE → Desperados, etc.
  //   - "ORI" (Original) is dropped; "SLV" → Silver; "WHE" → Wheat; "0.0" kept.
  //   - Pure numeric ml tokens become cl (<1000) or L (≥1000): 330 → 33cl, 8000 → 8L.
  // Unknown tokens pass through unchanged, so the function is safe on new SKUs.
  var BRAND_MAP = {
    'HE': 'Heineken',
    'TI': 'Tiger',
    'DE': 'Desperados',
    'ED': 'Edelweiss',
    'PA': 'Paulaner',
    'SU': 'Sol',
    'BI': 'Birra',
  };
  var FLAVOR_MAP = {
    'ORI': '',
    'SLV': 'Silver',
    'WHE': 'Wheat',
    '0.0': '0.0',
  };

  function humanizeSkuName(raw) {
    if (raw == null) return '';
    var tokens = String(raw).trim().split(/\s+/);
    if (!tokens.length) return '';

    if (Object.prototype.hasOwnProperty.call(BRAND_MAP, tokens[0])) {
      tokens[0] = BRAND_MAP[tokens[0]];
    }
    if (tokens.length > 1 && Object.prototype.hasOwnProperty.call(FLAVOR_MAP, tokens[1])) {
      var f = FLAVOR_MAP[tokens[1]];
      if (f === '') tokens.splice(1, 1);
      else tokens[1] = f;
    }
    for (var i = 0; i < tokens.length; i++) {
      if (/^\d+$/.test(tokens[i])) {
        var ml = parseInt(tokens[i], 10);
        tokens[i] = (ml >= 1000) ? (ml / 1000) + 'L' : (ml / 10) + 'cl';
      }
    }
    return tokens.join(' ');
  }

  window.TTS_DICT = TTS_DICT;
  window.convertForTTS = convertForTTS;
  window.pickPreferredVoice = pickPreferredVoice;
  window.humanizeSkuName = humanizeSkuName;
})();
