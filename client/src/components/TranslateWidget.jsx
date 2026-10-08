/**
 * Google Translate, split into an engine and a picker.
 *
 * `TranslateEngine` (mounted once in main.jsx) loads Google's `element.js`
 * and hosts the single hidden gadget for the whole session. The gadget is
 * kept off-screen on purpose: it is the control surface, not the UI, and a
 * single long-lived instance avoids the widget going missing when React
 * swaps the header between routes.
 *
 * `TranslateWidget` (the default export, used by PublicHeader) is a
 * first-party `<select>` that drives the hidden gadget, so the picker always
 * renders and can be styled freely - English is the default selection against
 * the navy header on every public screen, including the login page, and the
 * full Google language list is one pick away.
 *
 * The CSP in server/src/app.js allowlists exactly the third-party origins the
 * engine needs (`translate.google.com`, `translate.googleapis.com`,
 * `www.gstatic.com`) — without it the script below is blocked in production.
 *
 * Known limitation: Google's widget rewrites DOM text in place, so content a
 * React route change swaps in arrives in English. Each picker remounts with
 * its header and re-drives the engine, which restores the visitor's language
 * for the new page; content swapped in *without* a route change (a conditional
 * block appearing after an action, say) can still show in English.
 */

import { useEffect, useState } from 'react';
import { IconGlobe } from './icons.jsx';

// `?cb=` is load-bearing: Google bakes the callback name from this query
// parameter into its config, and with no `cb` the field comes back empty and
// `googleTranslateElementInit` is never invoked.
const GADGET_SRC =
  'https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
const ENGINE_ID = 'nb-translate-engine';

/**
 * Languages offered in the picker: every non-English language from Google's
 * official list that this widget actually accepts (verified against the live
 * `.goog-te-combo` option set). English is not a translation target — it is
 * the default state, rendered as its own entry in the picker.
 */
const LANGUAGE_OPTIONS = [
  { code: 'ab', label: 'Abkhaz' },
  { code: 'ace', label: 'Acehnese' },
  { code: 'ach', label: 'Acholi' },
  { code: 'af', label: 'Afrikaans' },
  { code: 'sq', label: 'Albanian' },
  { code: 'alz', label: 'Alur' },
  { code: 'am', label: 'Amharic' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hy', label: 'Armenian' },
  { code: 'as', label: 'Assamese' },
  { code: 'awa', label: 'Awadhi' },
  { code: 'ay', label: 'Aymara' },
  { code: 'az', label: 'Azerbaijani' },
  { code: 'ban', label: 'Balinese' },
  { code: 'bm', label: 'Bambara' },
  { code: 'ba', label: 'Bashkir' },
  { code: 'eu', label: 'Basque' },
  { code: 'btx', label: 'Batak Karo' },
  { code: 'bts', label: 'Batak Simalungun' },
  { code: 'bbc', label: 'Batak Toba' },
  { code: 'be', label: 'Belarusian' },
  { code: 'bem', label: 'Bemba' },
  { code: 'bn', label: 'Bengali' },
  { code: 'bew', label: 'Betawi' },
  { code: 'bho', label: 'Bhojpuri' },
  { code: 'bik', label: 'Bikol' },
  { code: 'bs', label: 'Bosnian' },
  { code: 'br', label: 'Breton' },
  { code: 'bg', label: 'Bulgarian' },
  { code: 'bua', label: 'Buryat' },
  { code: 'yue', label: 'Cantonese' },
  { code: 'ca', label: 'Catalan' },
  { code: 'ceb', label: 'Cebuano' },
  { code: 'ny', label: 'Chichewa (Nyanja)' },
  { code: 'zh-CN', label: 'Chinese (Simplified)' },
  { code: 'zh-TW', label: 'Chinese (Traditional)' },
  { code: 'cv', label: 'Chuvash' },
  { code: 'co', label: 'Corsican' },
  { code: 'crh', label: 'Crimean Tatar' },
  { code: 'hr', label: 'Croatian' },
  { code: 'cs', label: 'Czech' },
  { code: 'da', label: 'Danish' },
  { code: 'din', label: 'Dinka' },
  { code: 'dv', label: 'Divehi' },
  { code: 'doi', label: 'Dogri' },
  { code: 'dov', label: 'Dombe' },
  { code: 'nl', label: 'Dutch' },
  { code: 'dz', label: 'Dzongkha' },
  { code: 'eo', label: 'Esperanto' },
  { code: 'et', label: 'Estonian' },
  { code: 'ee', label: 'Ewe' },
  { code: 'fj', label: 'Fijian' },
  { code: 'tl', label: 'Filipino' },
  { code: 'fi', label: 'Finnish' },
  { code: 'fr', label: 'French' },
  { code: 'fr-CA', label: 'French (Canadian)' },
  { code: 'fy', label: 'Frisian' },
  { code: 'ff', label: 'Fulfulde' },
  { code: 'gaa', label: 'Ga' },
  { code: 'gl', label: 'Galician' },
  { code: 'lg', label: 'Ganda (Luganda)' },
  { code: 'ka', label: 'Georgian' },
  { code: 'de', label: 'German' },
  { code: 'el', label: 'Greek' },
  { code: 'gn', label: 'Guarani' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'ht', label: 'Haitian Creole' },
  { code: 'cnh', label: 'Hakha Chin' },
  { code: 'ha', label: 'Hausa' },
  { code: 'haw', label: 'Hawaiian' },
  { code: 'iw', label: 'Hebrew' },
  { code: 'hil', label: 'Hiligaynon' },
  { code: 'hi', label: 'Hindi' },
  { code: 'hmn', label: 'Hmong' },
  { code: 'hu', label: 'Hungarian' },
  { code: 'hrx', label: 'Hunsrik' },
  { code: 'is', label: 'Icelandic' },
  { code: 'ig', label: 'Igbo' },
  { code: 'ilo', label: 'Iloko' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ga', label: 'Irish' },
  { code: 'it', label: 'Italian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'jw', label: 'Javanese' },
  { code: 'kn', label: 'Kannada' },
  { code: 'pam', label: 'Kapampangan' },
  { code: 'kk', label: 'Kazakh' },
  { code: 'km', label: 'Khmer' },
  { code: 'cgg', label: 'Kiga' },
  { code: 'rw', label: 'Kinyarwanda' },
  { code: 'ktu', label: 'Kituba' },
  { code: 'gom', label: 'Konkani' },
  { code: 'ko', label: 'Korean' },
  { code: 'kri', label: 'Krio' },
  { code: 'ku', label: 'Kurdish (Kurmanji)' },
  { code: 'ckb', label: 'Kurdish (Sorani)' },
  { code: 'ky', label: 'Kyrgyz' },
  { code: 'lo', label: 'Lao' },
  { code: 'ltg', label: 'Latgalian' },
  { code: 'la', label: 'Latin' },
  { code: 'lv', label: 'Latvian' },
  { code: 'lij', label: 'Ligurian' },
  { code: 'li', label: 'Limburgan' },
  { code: 'ln', label: 'Lingala' },
  { code: 'lt', label: 'Lithuanian' },
  { code: 'lmo', label: 'Lombard' },
  { code: 'luo', label: 'Luo' },
  { code: 'lb', label: 'Luxembourgish' },
  { code: 'mk', label: 'Macedonian' },
  { code: 'mai', label: 'Maithili' },
  { code: 'mak', label: 'Makassar' },
  { code: 'mg', label: 'Malagasy' },
  { code: 'ms', label: 'Malay' },
  { code: 'ms-Arab', label: 'Malay (Jawi)' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'mt', label: 'Maltese' },
  { code: 'mi', label: 'Maori' },
  { code: 'mr', label: 'Marathi' },
  { code: 'chm', label: 'Meadow Mari' },
  { code: 'mni-Mtei', label: 'Meiteilon (Manipuri)' },
  { code: 'min', label: 'Minang' },
  { code: 'lus', label: 'Mizo' },
  { code: 'mn', label: 'Mongolian' },
  { code: 'my', label: 'Myanmar (Burmese)' },
  { code: 'nr', label: 'Ndebele (South)' },
  { code: 'new', label: 'Nepalbhasa (Newari)' },
  { code: 'ne', label: 'Nepali' },
  { code: 'nso', label: 'Northern Sotho (Sepedi)' },
  { code: 'no', label: 'Norwegian' },
  { code: 'nus', label: 'Nuer' },
  { code: 'oc', label: 'Occitan' },
  { code: 'or', label: 'Odia (Oriya)' },
  { code: 'om', label: 'Oromo' },
  { code: 'pag', label: 'Pangasinan' },
  { code: 'pap', label: 'Papiamento' },
  { code: 'ps', label: 'Pashto' },
  { code: 'fa', label: 'Persian' },
  { code: 'pl', label: 'Polish' },
  { code: 'pt', label: 'Portuguese (Brazil)' },
  { code: 'pt-PT', label: 'Portuguese (Portugal)' },
  { code: 'pa', label: 'Punjabi' },
  { code: 'pa-Arab', label: 'Punjabi (Shahmukhi)' },
  { code: 'qu', label: 'Quechua' },
  { code: 'rom', label: 'Romani' },
  { code: 'ro', label: 'Romanian' },
  { code: 'rn', label: 'Rundi' },
  { code: 'ru', label: 'Russian' },
  { code: 'sm', label: 'Samoan' },
  { code: 'sg', label: 'Sango' },
  { code: 'sa', label: 'Sanskrit' },
  { code: 'gd', label: 'Scots Gaelic' },
  { code: 'sr', label: 'Serbian' },
  { code: 'st', label: 'Sesotho' },
  { code: 'crs', label: 'Seychellois Creole' },
  { code: 'shn', label: 'Shan' },
  { code: 'sn', label: 'Shona' },
  { code: 'scn', label: 'Sicilian' },
  { code: 'szl', label: 'Silesian' },
  { code: 'sd', label: 'Sindhi' },
  { code: 'si', label: 'Sinhala (Sinhalese)' },
  { code: 'sk', label: 'Slovak' },
  { code: 'sl', label: 'Slovenian' },
  { code: 'so', label: 'Somali' },
  { code: 'es', label: 'Spanish' },
  { code: 'su', label: 'Sundanese' },
  { code: 'sw', label: 'Swahili' },
  { code: 'ss', label: 'Swati' },
  { code: 'sv', label: 'Swedish' },
  { code: 'tg', label: 'Tajik' },
  { code: 'ta', label: 'Tamil' },
  { code: 'tt', label: 'Tatar' },
  { code: 'te', label: 'Telugu' },
  { code: 'tet', label: 'Tetum' },
  { code: 'th', label: 'Thai' },
  { code: 'ti', label: 'Tigrinya' },
  { code: 'ts', label: 'Tsonga' },
  { code: 'tn', label: 'Tswana' },
  { code: 'tr', label: 'Turkish' },
  { code: 'tk', label: 'Turkmen' },
  { code: 'ak', label: 'Twi (Akan)' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'ur', label: 'Urdu' },
  { code: 'ug', label: 'Uyghur' },
  { code: 'uz', label: 'Uzbek' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'cy', label: 'Welsh' },
  { code: 'xh', label: 'Xhosa' },
  { code: 'yi', label: 'Yiddish' },
  { code: 'yo', label: 'Yoruba' },
  { code: 'yua', label: 'Yucatec Maya' },
  { code: 'zu', label: 'Zulu' },
];

/**
 * The most recent language Google could not take yet — the engine was still
 * loading, or the combo existed but its options had not arrived. Retried
 * briefly by `applyLanguage` so a pick is never dropped.
 */
let pendingLanguage = '';
let flushTimer = null;

/** Hands a language to Google by driving its own hidden combo box. */
function driveCombo(language) {
  const combo = document.querySelector('.goog-te-combo');
  if (!combo) return false;
  combo.value = language;
  // The combo element exists a beat before its options are populated, and
  // assigning a value with no matching option silently no-ops. Report that
  // as failure so the caller queues instead of losing the pick.
  if (combo.value !== language) return false;
  combo.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/**
 * Back to English. Google's combo deliberately ignores `""` — its change
 * handler snaps straight back to the last language — and the embed mode used
 * here exposes no restore API (`TranslateService` is only registered in a
 * different mode). The one reliable revert is therefore to drop the
 * `googtrans` cookie and reload: the engine starts fresh in English with
 * nothing to auto-apply. If the page was never translated, this is a no-op.
 */
function restoreOriginal() {
  const translated =
    Boolean(document.querySelector('.goog-te-combo')?.value) ||
    /(?:^|;\s*)googtrans=/.test(document.cookie);
  for (const path of ['/', window.location.pathname]) {
    document.cookie = `googtrans=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}`;
  }
  if (translated) window.location.reload();
}

/** Applies a language now if the engine can take it, otherwise queues it. */
function applyLanguage(language) {
  if (!language) {
    // English: nothing to queue — either the page is translated (revert, via
    // reload) or it is already English (no-op).
    pendingLanguage = '';
    restoreOriginal();
    return;
  }
  pendingLanguage = language;
  if (driveCombo(language)) {
    pendingLanguage = '';
    return;
  }
  if (flushTimer !== null) return;
  let tries = 0;
  flushTimer = setInterval(() => {
    if (!pendingLanguage) {
      clearInterval(flushTimer);
      flushTimer = null;
      return;
    }
    if (driveCombo(pendingLanguage)) pendingLanguage = '';
    tries += 1;
    if (tries > 60) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }, 100);
}

/** The active language: Google's combo if the engine is up, else its cookie. */
function currentLanguage() {
  const combo = document.querySelector('.goog-te-combo');
  if (combo) return combo.value;
  const match = document.cookie.match(
    /(?:^|;\s*)googtrans=(?:%2F|\/)[^/;]*(?:%2F|\/)([A-Za-z-]+)/,
  );
  return match ? decodeURIComponent(match[1]) : '';
}

/** True while a non-English translation is active (combo or cookie). */
export function hasActiveLanguage() {
  return Boolean(currentLanguage());
}

/**
 * Re-applies the visitor's language to DOM a React route change just swapped
 * in. Called by `TranslateRouteSync` on every navigation: route changes
 * replace the page with fresh English content while Google's combo keeps the
 * old language, so without this the signed-in portal comes up in English.
 */
export function retranslate() {
  const active = currentLanguage();
  if (active) applyLanguage(active);
}

/** Guards against constructing the gadget twice (StrictMode re-runs, HMR). */
let engineStarted = false;

function initEngine() {
  if (engineStarted) return;
  const container = document.getElementById(ENGINE_ID);
  if (!window.google?.translate?.TranslateElement || !container) return;

  engineStarted = true;
  new window.google.translate.TranslateElement(
    {
      pageLanguage: 'en',
      includedLanguages: LANGUAGE_OPTIONS.map((option) => option.code).join(','),
      autoDisplay: false,
    },
    ENGINE_ID,
  );

  // Google's combo can materialise synchronously or a beat later. Poll
  // briefly so pickers only sync (and the mount-time re-drive queues) once
  // there is something to bind to. Queued languages are flushed by
  // `applyLanguage`'s own retry, which also covers options arriving late.
  let attempts = 0;
  const settle = () => {
    if (document.querySelector('.goog-te-combo') || attempts >= 120) {
      window.dispatchEvent(new Event('nb-translate-ready'));
      return;
    }
    attempts += 1;
    setTimeout(settle, 50);
  };
  settle();
}

export function TranslateEngine() {
  useEffect(() => {
    // element.js invokes this global (its default `cb`) once loaded. The
    // initialiser is idempotent, so StrictMode's effect re-run racing the
    // script load is harmless.
    window.googleTranslateElementInit = initEngine;
    initEngine();

    if (document.querySelector('script[data-nb-translate]')) return;
    const script = document.createElement('script');
    script.src = GADGET_SRC;
    script.async = true;
    script.setAttribute('data-nb-translate', '');
    document.body.appendChild(script);

    // The callback normally fires as soon as the script lands, but a slow or
    // partially blocked chain must not leave the engine dead forever: keep
    // retrying briefly until the API shows up. (Script already present means
    // a previous mount owns this — or the callback path will cover it.)
    let attempts = 0;
    const retry = setInterval(() => {
      attempts += 1;
      if (engineStarted || attempts > 120) {
        clearInterval(retry);
        return;
      }
      initEngine();
    }, 250);
  }, []);

  return <div id={ENGINE_ID} className="translate-engine" aria-hidden="true" />;
}

export default function TranslateWidget() {
  const [language, setLanguage] = useState(currentLanguage);

  useEffect(() => {
    // A React route change replaces the page with fresh English DOM. Redrive
    // Google on mount so the visitor's language comes back automatically
    // instead of them having to re-pick it on every page.
    const active = currentLanguage();
    if (active) applyLanguage(active);

    let combo = null;
    const sync = () => setLanguage(currentLanguage());
    const bindCombo = () => {
      if (combo) return;
      combo = document.querySelector('.goog-te-combo');
      combo?.addEventListener('change', sync);
    };
    const handleReady = () => {
      bindCombo();
      sync();
    };

    bindCombo();
    window.addEventListener('nb-translate-ready', handleReady);
    return () => {
      window.removeEventListener('nb-translate-ready', handleReady);
      combo?.removeEventListener('change', sync);
    };
  }, []);

  const handleChange = (event) => {
    const next = event.target.value;
    setLanguage(next);
    // English is the untranslated default, never a Google target: pass the
    // empty marker so a live translation reverts (cookie clear + reload) and
    // an already-English page stays put.
    applyLanguage(next === 'en' ? '' : next);
  };

  return (
    <div className="translate-widget">
      <IconGlobe size={16} className="translate-widget__icon" />
      <select
        className="translate-widget__select"
        value={language || 'en'}
        onChange={handleChange}
        aria-label="Translate this website"
      >
        <option value="en">English</option>
        {LANGUAGE_OPTIONS.map((option) => (
          <option key={option.code} value={option.code}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
