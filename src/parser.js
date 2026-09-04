// Regex-based order parser. Works fully offline - no API key needed.
// Handles messy Hinglish / informal messages like:
//   "Order from Mayank, 500 grams ladoo, +15% profit, total cost of ladoo=200 rupees"
//   "sold 1kg kaju katli to sharma uncle, cost 850, profit 20%"
//   "ravi kirana ne 5kg namkeen mange, cost 400, profit 18%"
//   "bhaiya 500g laddu chahiye" / "500g pedhe pahije" / "500g laddu kavali"
// Native-script messages (Devanagari, Bengali, Tamil, Telugu, Kannada,
// Malayalam, Gujarati, Gurmukhi, Urdu) use dedicated u-flag regexes with
// \p{L} lookarounds - \b word boundaries are ASCII-only in JavaScript.
// Risky single words (do/dena/dya/din/kodi/tharu...) are only trusted inside
// multi-word phrases, never standalone, to avoid false positives on chat.

const UNITS = 'kg|kgs|kilogram|kilograms|kilo|kilos|keji|gram|grams|graam|gms|gm|g|dozen|darjan|pcs|pieces|piece|pees|pis|nag|ml|millilitre|millilitres|milliliter|milliliters|litre|litres|liter|liters|l|ser|seer|sher|pav|paav|poa|tola|thola|tol|ratti|chatak|chhatank|masha|vori|ennam|ennikkai|mukka|item|ta';

const QUANTITY_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNITS})\\b`, 'i');
const UNIT_NOT_AFTER = new RegExp(`(?!\\s*(?:${UNITS})\\b)`, 'i');
const COST_RE = /(?:total\s*)?(?:cost|cp|base\s*price|buying\s*price|price)\s*(?:of\s*[a-z ]+)?\s*(?:[=:]|is|are)?\s*(?:rs\.?|rupees|inr|\u20B9)?\s*(\d+(?:\.\d+)?)/i;
const SOLD_FOR_RE = new RegExp(
  `\\b(?:sold|sell|selling)\\b\\s*(?:it\\s*)?(?:at|for|in|to\\s+\\w+)?\\s*(?:rs\\.?|rupees|inr|\\u20B9)?\\s*(\\d+(?:\\.\\d+)?)\\b${UNIT_NOT_AFTER.source}`,
  'i'
);
const PROFIT_PCT_RE = /\+?\s*(\d+(?:\.\d+)?)\s*%/;
const PROFIT_PCT_WORD_RE = /(?:profit|margin)\s*(?:is|=|:|of|@)?\s*(\d+(?:\.\d+)?)\s*%/i;
const PROFIT_AMT_RE = /(?:profit|margin)\s*(?:is|=|:|of)?\s*(?:rs\.?|rupees|inr|\u20B9)?\s*(\d+(?:\.\d+)?)\b(?!\s*%)/i;
const TOTAL_RE = /total\s*(?:amount|price|sell(?:ing)?)?\s*(?:[=:]|is)?\s*(?:rs\.?|rupees|inr|\u20B9)?\s*(\d+(?:\.\d+)?)/i;

// Fractional spoken quantities: "aadha kilo besan", "dedh kg doodh"...
const FRACTION_QTY_RE = /\b(aadha|adha|ardha|half|dedh|dhai|sava|savva)\s*(kilo|kilos|kg|keji|gram|litre|liter)\b/i;
const FRACTION_VALUES = { aadha: 0.5, adha: 0.5, ardha: 0.5, half: 0.5, dedh: 1.5, dhai: 1.5, sava: 1.25, savva: 1.25 };

// Order intent, Roman script: safe single words + distinctive phrases.
const ROMAN_INTENT_RE = new RegExp(
  '\\b(?:order(?:ed|s)?|sold|sale|sell|bill|invoice|mangwaya|mange|mangaye|chahiye|bhejo|bhejna|bhej|kitna|kitne|mujhe|pahije|chai|kavali|beku|venam|venum|chahida|joie|kalisi|kaluhisi|anuppunga|pampandi)\\b' +
  '|\\b(?:bana do|bana dena|de do|de dena|bhej do|bhej dena|taiyar kar do|tayar kar do|pack kar do|pack kar dena|ghar bhej|kitne ka|kitne mein|kitna lagega|rate kya|bhav batao|price batao|bhao kya|qeemat kya|total kitna|kiti padel|kiti hoil|kiti rupayala|bhav kay|rate sanga|kimmat sanga|total kiti|pathavun dya|banvun dya|tayar karun|pack karun|ghari pathva|koto porbe|koto hobe|dam koto|rate koto|total koto|koto taka|pathiye din|baniye din|toiri kore din|ready kore din|pack kore din|rekhe din|senju kudunga|ready pannunga|pack pannunga|veetukku anuppunga|evlo aagum|evlo varum|rate enna|price enna|vilai enna|total evlo|pampincheyandi|ivvandi|ichcheyandi|chesi ivvandi|tayaru cheyandi|ready cheyandi|pack cheyandi|entha avutundi|entha padutundi|rate entha|price entha|dhara entha|total entha|manege kalisi|tayarisi kodi|ittu kodi|madi kodi|ready madi|pack madi|eshtu agutte|eshtu barutte|bele eshtu|rate eshtu|price eshtu|total eshtu|ayachu tharu|ayach tharu|veettil ayakku|cheithu tharu|undakki tharu|ready aakki|pack cheythu|ethra aakum|ethra varum|vila ethra|rate ethra|price ethra|total ethra|ethra roopa|mokli do|mokli aapo|aapi do|aapi aapo|banavi aapo|taiyar kari aapo|ready kari do|pack kari do|rakhi do|ghare mokli|ketla thashe|ketlama malse|bhav ketlo|rate ketlo|ketlu padse|total ketlu|ketla rupiya|bhej deo|de deo|bana deo|tyaar kar deo|ready kar deo|pack kar deo|rakh deo|kinne da pavega|kinne nu milega|rate ki aa|bhav ki aa|price kinne di|kinne da aa|total kinna|kinne paise|bhej dein|de dein|bana dein|tayyar kar dein|kitne ka hoga|delivery kar do|delivery kore din|delivery pannunga|delivery cheyandi|delivery madi|delivery kari do)\\b' +
  '|(?:can|may)\\s+i\\s+(?:get|have|order)|i\\s+(?:want|need)\\b',
  'i'
);

// ---- Native-script support (u-flag, \p{L}/\p{M} lookarounds) ----
const NATIVE_DIGITS = '०१२३४५६७८९০১২৩৪৫৬৭৮৯௦௧௨௩௪௫௬௭௮௯౦౧౨౩౪౫౬౭౮౯೦೧೨೩೪೫೬೭೮೯൦൧൨൩൪൫൬൭൮൯੦੧੨੩੪੫੬੭੮੯۰۱۲۳۴۵۶۷۸۹';
const DIGIT_MAP = (() => {
  const m = {};
  for (let c = 0; c < NATIVE_DIGITS.length; c += 10) {
    for (let i = 0; i < 10; i++) m[NATIVE_DIGITS[c + i]] = String(i);
  }
  return m;
})();
function normalizeDigits(s) { return String(s).replace(/./g, (ch) => DIGIT_MAP[ch] || ch); }

const NATIVE_INTENT = [
  'चाहिए', 'भेज दो', 'भेज देना', 'भेजो', 'बना दो', 'बना देना', 'दे दो', 'दे देना',
  'तैयार कर दो', 'तैयार कर देना', 'पैक कर दो', 'पैक कर देना', 'पैक करके भेज दो',
  'रख देना', 'डिलीवर कर दो', 'घर भेज', 'कितने का', 'कितने में', 'कितना लगेगा',
  'भाव बताओ', 'रेट क्या', 'प्राइस बताओ', 'टोटल कितना', 'ऑर्डर',
  'بھیج دو', 'بھیج دیں', 'بنا دو', 'بنا دیں', 'تیار کر دو', 'پیک کر دو', 'گھر بھیج',
  'کتنے کا', 'کتنے میں', 'کتنا لگے گا', 'قیمت کیا', 'بھاؤ کیا', 'ٹوٹل کتنا', 'آرڈر', 'چاہیے',
  'पाहिजे', 'पाठवा', 'पाठवून द्या', 'बनवून द्या', 'तयार करून', 'पॅक करून',
  'किती पडेल', 'किती होईल', 'भाव काय', 'रेट सांगा', 'किंमत सांगा', 'टोटल किती',
  'চাই', 'অর্ডার', 'পাঠিয়ে দিন', 'বানিয়ে দিন', 'তৈরি করে দিন',
  'রেখে দিন', 'প্যাক করে দিন', 'কত পড়বে', 'কত হবে', 'দাম কত', 'কত টাকা', 'টোটাল কত',
  'வேண்டும்', 'ஆர்டர்', 'அனுப்புங்க', 'அனுப்பி விடுங்க', 'செஞ்சு குடுங்க',
  'ரெடி பண்ணுங்க', 'பேக் பண்ணுங்க', 'வீட்டுக்கு அனுப்புங்க',
  'எவ்வளவு ஆகும்', 'எவ்வளவு வரும்', 'ரேட் என்ன', 'விலை என்ன', 'டோட்டல் எவ்வளவு',
  'కావాలి', 'ఆర్డర్', 'పంపండి', 'పంపించేయండి', 'ఇవ్వండి', 'ఇచ్చేయండి',
  'తయారు చేయండి', 'రెడీ చేయండి', 'ప్యాక్ చేయండి',
  'ఎంత అవుతుంది', 'ఎంత పడుతుంది', 'రేట్ ఎంత', 'ధర ఎంత', 'టోటల్ ఎంత',
  'ಬೇಕು', 'ಆರ್ಡರ್', 'ಕಳಿಸಿ', 'ಕಳುಹಿಸಿ', 'ಮನೆಗೆ ಕಳಿಸಿ', 'ತಯಾರಿಸಿ ಕೊಡಿ',
  'ಇಟ್ಟು ಕೊಡಿ', 'ರೆಡಿ ಮಾಡಿ', 'ಪ್ಯಾಕ್ ಮಾಡಿ',
  'ಎಷ್ಟು ಆಗುತ್ತೆ', 'ಎಷ್ಟು ಬರುತ್ತೆ', 'ಬೆಲೆ ಎಷ್ಟು', 'ರೇಟ್ ಎಷ್ಟು', 'ಟೋಟಲ್ ಎಷ್ಟು',
  'വേണം', 'ഓർഡർ', 'അയച്ചു തരൂ', 'അയക്കൂ', 'ചെയ്ത് തരൂ', 'ഉണ്ടാക്കി തരൂ',
  'പാക്ക് ചെയ്ത് തരൂ', 'വീട്ടിൽ അയക്കൂ',
  'എത്ര ആകും', 'എത്ര വരും', 'വില എത്ര', 'റേറ്റ് എത്ര', 'ടോട്ടൽ എത്ര',
  'જોઈએ', 'ઓર્ડર', 'મોકલી દો', 'મોકલી આપો', 'આપી દો', 'આપી આપો', 'બનાવી આપો',
  'તૈયાર કરી', 'રેડી કરી', 'પેક કરી', 'રાખી દો',
  'કેટલા થશે', 'કેટલું પડશે', 'ભાવ કેટલો', 'રેટ કેટલો', 'ટોટલ કેટલું',
  'ਚਾਹੀਦਾ', 'ਆਰਡਰ', 'ਭੇਜ ਦਿਓ', 'ਬਣਾ ਦਿਓ', 'ਤਿਆਰ ਕਰ ਦਿਓ', 'ਰੈਡੀ ਕਰ ਦਿਓ',
  'ਪੈਕ ਕਰ ਦਿਓ', 'ਰੱਖ ਦਿਓ', 'ਕਿੰਨੇ ਦਾ', 'ਕਿੰਨੇ ਪੈਸੇ', 'ਰੇਟ ਕੀ', 'ਭਾਅ ਕੀ', 'ਟੋਟਲ ਕਿੰਨਾ',
];
const NATIVE_UNITS = [
  'किलो', 'केजी', 'किलोग्राम', 'किलोग्रॅम', 'কিলো', 'কেজি', 'কিলোগ্রাম', 'கிலோ', 'கிலோகிராம்',
  'కిలో', 'కిలోగ్రామ్', 'కేజీ', 'ಕಿಲೋ', 'ಕಿಲೋಗ್ರಾಂ', 'ಕೆಜಿ', 'കിലോ', 'കിലോഗ്രാം',
  'કિલો', 'કિલોગ્રામ', 'ਕਿਲੋ', 'ਕਿਲੋਗ੍ਰਾਮ', 'ਕੇਜੀ', 'کلو', 'کلوگرام',
  'ग्राम', 'ग्रॅम', 'গ্রাম', 'கிராம்', 'గ్రాము', 'ಗ್ರಾಂ', 'ಗ್ರಾಮ', 'ഗ്രാം', 'ગ્રામ', 'ਗ੍ਰਾਮ', 'گرام',
  'तोला', 'तोळा', 'तोळ', 'रत्ती', 'छटांक', 'চটক', 'ভরি', 'তোলা', 'தோலா', 'தோலை',
  'తులం', 'తులా', 'ತೊಲ', 'ತೊಲೆ', 'ರತ್ತಿ', 'തൊല', 'രത്തി', 'તોલા', 'તોલ', 'રતી',
  'ਤੋਲਾ', 'ਤੋਲ', 'ਰੱਤੀ', 'تولہ', 'تول', 'رتی', 'ماشہ',
  'लिटर', 'লিটার', 'லிட்டர்', 'లీటర్', 'ಲೀಟರ್', 'ലിറ്റർ', 'લીટર', 'ਲੀਟਰ', 'لیٹر',
  'मिलीलीटर', 'मिली',
  'पीस', 'नग', 'পিস', 'টা', 'பீஸ்', 'పీస్', 'ముక్క', 'ಪೀಸ್', 'ಐಟಂ', 'എണ്ണം', 'પીસ', 'નંગ', 'ਪੀਸ', 'ਨਗ', 'پیس', 'عدد',
  'दर्जन', 'डझन', 'ডজন', 'டஜன்', 'డజన్', 'ಡಜನ್', 'ഡസൻ', 'ડઝન', 'ਦਰਜਨ', 'درجن',
  'కిలోలు', 'కిలోల', 'గ్రాములు', 'గ్రాముల', 'లీటర్లు', 'డజన్లు',
  'सेर', 'शेर', 'সের', 'পোয়া', 'சேர்', 'படி', 'సేరు', 'ಸೇರು', 'സേർ', 'શેર', 'ਸੇਰ', 'سیر',
  'पाव', 'பாவு', 'పావు', 'ಪಾವು', 'പാവ്', 'પાવ', 'ਪਾਵ', 'پاؤ',
];
const NATIVE_UNIT_MAP = (() => {
  const groups = [
    ['किलो केजी किलोग्राम किलोग्रॅম কিলো কেজি কিলোগ্রাম கிலோ கிலோகிராம் కిలో కిలోగ్రామ్ కేజీ ಕಿಲೋ ಕಿಲೋಗ್ರಾಂ ಕೆಜಿ കിലോ കിലോഗ്രാം કિલો કિલોગ્રામ ਕਿਲੋ ਕਿਲੋਗ੍ਰਾਮ ਕੇਜੀ کلو کلوگرام', 'kg'],
    ['ग्राम ग्रॅम গ্রাম கிராம் గ్రాము ಗ್ರಾಂ ಗ್ರಾಮ ഗ്രാം ગ્રામ ਗ੍ਰਾਮ گرام तोला तोळा तोळ रत्ती छटांक ভরি তোলা தோலா தோலை తులం తులా ತೊಲ ತೊಲೆ ರತ್ತಿ തൊല രത്തિ તોલા તોલ રતી ਤੋਲਾ ਤੋਲ ਰੱਤੀ تولہ تول رتی ماشہ', 'g'],
    ['लीटर লিটার லிட்டர் లీటర్ ಲೀಟರ್ ലിറ്റർ લીટર ਲੀટર لیٹر', 'l'],
  ['मिलीलीटर मिली', 'ml'],
    ['पीस नग পিস টা பீஸ் పీస్ ముక్క ಪೀಸ್ ಐಟಂ എണ്ണം પીસ નંગ ਪੀਸ ਨਗ پیس عدد', 'pcs'],
    ['दर्जन डझन ডজন டஜன் డజನ್ ಡಜನ್ ഡസൻ ડઝન ਦર்ஜન درجن', 'dozen'],
    ['కిలోలు కిలోల గ్రాములు గ్రాముల లీటర్లు డజన్లు', 'dozen'],
    ['सेर शेर সের পোয়া சேர் படி సేరు ಸೇರು സേർ શેર ਸੇਰ سیر पाव பாவு పావు ಪಾವು പാവ് પાવ ਪাাਵ پاؤ', 'kg'],
  ];
  const m = {};
  for (const [words, c] of groups) for (const w of words.split(' ')) if (w) m[w] = c;
  return m;
})();

const B = '(?<![\\p{L}\\p{M}])';
const A = '(?![\\p{L}\\p{M}])';
const NATIVE_INTENT_RE = new RegExp(`${B}(?:${NATIVE_INTENT.join('|')})${A}`, 'u');
const NATIVE_QUANTITY_RE = new RegExp(`${B}([${NATIVE_DIGITS}]+)\\s*(${NATIVE_UNITS.join('|')})${A}`, 'u');
// The most common real-world mix: ASCII digits + native unit ("500 கிராம்", "2 किलो")
const MIXED_QUANTITY_RE = new RegExp(`${B}(\\d+(?:\\.\\d+)?)\\s*(${NATIVE_UNITS.join('|')})${A}`, 'u');
// Devanagari spoken fractions: "आधा किलो", "डेढ़ किलो"...
const NATIVE_FRACTION_RE = new RegExp(`${B}(आधा|अर्धा|आर्धा|सवा|डेढ़|ढाई)\\s*(किलो|केजी|ग्राम|लीटर)${A}`, 'u');
const NATIVE_FRACTION_VALUES = { 'आधा': 0.5, 'अर्धा': 0.5, 'आर्धा': 0.5, 'सवा': 1.25, 'डेढ़': 1.5, 'ढाई': 2.5 };
const NATIVE_ITEM_TAIL_RE = new RegExp(
  `\\s*(?:${['चाहिए', 'भेज दो', 'भेज देना', 'दे दो', 'दे देना', 'बना दो', 'बना देना', 'रख दो', 'पैक कर दो', 'तैयार कर दो', 'घर भेज', 'डिलीवर कर दो', 'पाहिजे', 'पाठवा', 'पाठवून द्या', 'বানিয়ে দিন', 'তৈরি করে দিন', 'রেখে দিন', 'প্যাক করে দিন', 'পাঠিয়ে দিন', 'வேண்டும்', 'அனுப்புங்க', 'குடுங்க', 'செஞ்சு குடுங்க', 'ரெடி பண்ணுங்க', 'பேக் பண்ணுங்க', 'కావాలి', 'పంపండి', 'ఇవ్వండి', 'తయారు చేయండి', 'రెడీ చేయండి', 'ప్యాక్ చేయండి', 'ಬೇಕು', 'ಕಳಿಸಿ', 'ಕೊಡಿ', 'ತಯಾರಿಸಿ ಕೊಡಿ', 'ರೆಡಿ ಮಾಡಿ', 'ಪ್ಯಾಕ್ ಮಾಡಿ', 'വേണം', 'തരൂ', 'അയക്കൂ', 'ചെയ്ത് തരൂ', 'ഉണ്ടാക്കി തരൂ', 'പാക്ക് ചെയ്ത് തരൂ', 'જોઈએ', 'મોકલી દો', 'આપી દો', 'બનાવી આપો', 'તૈયાર કરી આપો', 'રેડી કરી દો', 'પેક કરી દો', 'રાખી દો', 'ਚਾਹੀਦਾ', 'ਭੇਜ ਦਿਓ', 'ਦੇ ਦਿਓ', 'ਬਣਾ ਦਿਓ', 'ਤਿਆਰ ਕਰ ਦਿਓ', 'ਪੈਕ ਕਰ ਦਿਓ', 'ਰੱਖ ਦਿਓ', 'چاہیے', 'بھیج دو', 'دے دو', 'بنا دو', 'تیار کر دو', 'پیک کر دو', 'گھر بھیج دو'].join('|')})${A}.*$`,
  'u'
);

// Customer name: tried in priority order, first match wins
const CUSTOMER_RES = [
  /order\s*from\s+([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit|\s+\+)/i,
  /(?:customer|client)\s*[:\-]\s*([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit)/i,
  /\bsold\b[^,.]*?\bto\s+([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit)/i,
  /\bfor\s+([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit)/i,
  /\b([A-Za-z][A-Za-z ]{1,30}?)\s+ne\b/i, // Hinglish: "ravi kirana ne 5kg namkeen mange"
];

const UNIT_NORMALIZE = {
  kg: 'kg', kgs: 'kg', kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg', keji: 'kg',
  gram: 'g', grams: 'g', graam: 'g', gms: 'g', gm: 'g', g: 'g',
  dozen: 'dozen', darjan: 'dozen',
  pcs: 'pcs', pieces: 'pcs', piece: 'pcs', pees: 'pcs', pis: 'pcs', nag: 'pcs',
  ennam: 'pcs', ennikkai: 'pcs', mukka: 'pcs', item: 'pcs', ta: 'pcs',
  litre: 'l', litres: 'l', liter: 'l', liters: 'l', l: 'l',
  ml: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  ser: 'kg', seer: 'kg', sher: 'kg', pav: 'kg', paav: 'kg', poa: 'kg',
  tola: 'g', thola: 'g', tol: 'g', ratti: 'g', chatak: 'g', chhatank: 'g', masha: 'g', vori: 'g',
};

const ITEM_TAIL_STOP = /\s+(?:mange|mangwaya|mangaye|chahiye|bhejo|bhejna|bhej|karo|krdo|please|ke\s+liye|pahije|pathva|banvun|kavali|beku|venam|venum|chahida|joie|kalisi|kaluhisi|anuppunga|pampandi|kudunga|tharu|pathan|din|dya|venam|bana do|bana dena|de do|de dena|bhej do|bhej dena|taiyar kar do|pack kar do|pathavun dya|banvun dya|pathiye din|baniye din|pack kore din|rekhe din|ready pannunga|pack pannunga|pampincheyandi|ivvandi|ready cheyandi|pack cheyandi|ready madi|pack madi|ittu kodi|madi kodi|ayachu tharu|ayach tharu|cheithu tharu|undakki tharu|pack cheythu|mokli do|mokli aapo|aapi do|banavi aapo|ready kari do|pack kari do|rakhi do|bhej deo|bana deo|de deo|tyaar kar deo|ready kar deo|pack kar deo|rakh deo|bhej dein|de dein|bana dein|tayyar kar dein|delivery kar do)\b.*$/i;

function toNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function titleCase(name) {
  return name
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function extractCustomer(text) {
  for (const re of CUSTOMER_RES) {
    const m = text.match(re);
    if (m && m[1]) {
      const name = m[1].replace(/\b(cost|price|profit|rs|rupees|total|ne)\b\s*$/i, '').trim();
      if (name) return titleCase(name);
    }
  }
  return null;
}

function extractItem(text, qtyMatch) {
  if (!qtyMatch) return null;
  const before = text.slice(Math.max(0, qtyMatch.index - 40), qtyMatch.index);
  const after = text.slice(qtyMatch.index + qtyMatch[0].length, qtyMatch.index + qtyMatch[0].length + 40);
  // item right after the unit: "500 grams ladoo", "2kg ke laddu"
  let m = after.match(/^\s*(?:ke\s+|ka\s+|ki\s+|of\s+)?([a-z][a-z ]{1,25}?)(?=\s*[,.!=]|$|\s+\d|\s+cost|\s+price|\s+profit|\s+for|\s+sold|\s+to\b|\s+ne\b)/i);
  if (m && m[1].trim()) {
    return m[1].trim().replace(ITEM_TAIL_STOP, '').replace(NATIVE_ITEM_TAIL_RE, '').replace(/\s+/g, ' ');
  }
  // item before the qty: "ladoo 500 grams", "chocolate cake 2kg"
  m = before.match(/([a-z][a-z]{2,24})\s*(?:ke|ka|ki|of)?\s*$/i);
  if (m && !/^(from|order|total|cost|price|profit|for|sold|sell)$/i.test(m[1])) return m[1].trim();
  return null;
}

function matchQuantity(text) {
  const qtyMatch = text.match(QUANTITY_RE);
  if (qtyMatch) {
    return {
      quantity: toNum(qtyMatch[1]),
      unit: UNIT_NORMALIZE[qtyMatch[2].toLowerCase()] || null,
      match: qtyMatch,
    };
  }
  const nq = text.match(NATIVE_QUANTITY_RE);
  if (nq) {
    return {
      quantity: toNum(normalizeDigits(nq[1])),
      unit: NATIVE_UNIT_MAP[nq[2]] || null,
      match: nq,
    };
  }
  const mq = text.match(MIXED_QUANTITY_RE);
  if (mq) {
    return {
      quantity: toNum(mq[1]),
      unit: NATIVE_UNIT_MAP[mq[2]] || null,
      match: mq,
    };
  }
  const nfq = text.match(NATIVE_FRACTION_RE);
  if (nfq) {
    return {
      quantity: NATIVE_FRACTION_VALUES[nfq[1]] || null,
      unit: NATIVE_UNIT_MAP[nfq[2]] || null,
      match: nfq,
    };
  }
  const fq = text.match(FRACTION_QTY_RE);
  if (fq) {
    return {
      quantity: FRACTION_VALUES[fq[1].toLowerCase()] || null,
      unit: UNIT_NORMALIZE[fq[2].toLowerCase()] || null,
      match: fq,
    };
  }
  return null;
}

/**
 * Parse a WhatsApp message into a structured order.
 * Returns null when the message does not look like an order.
 */
function parseOrder(text) {
  if (!text) return null;
  const hasIntent = ROMAN_INTENT_RE.test(text) || NATIVE_INTENT_RE.test(text);
  if (!hasIntent) return null;

  const customer = extractCustomer(text);

  const qty = matchQuantity(text);
  const quantity = qty ? qty.quantity : null;
  const unit = qty ? qty.unit : null;
  const item = extractItem(text, qty ? qty.match : null);

  let costPrice = null;
  let totalAmount = null;
  let profitPercent = null;
  let profitAmount = null;

  const costMatch = text.match(COST_RE);
  if (costMatch) costPrice = toNum(costMatch[1]);

  const pctDirect = text.match(PROFIT_PCT_RE);
  const pctWord = text.match(PROFIT_PCT_WORD_RE);
  if (pctDirect) profitPercent = toNum(pctDirect[1]);
  else if (pctWord) profitPercent = toNum(pctWord[1]);

  const profitAmtMatch = text.match(PROFIT_AMT_RE);
  if (profitAmtMatch) profitAmount = toNum(profitAmtMatch[1]);

  // "sold ... for 800" -> selling price (total), but never the quantity itself
  const soldMatch = text.match(SOLD_FOR_RE);
  if (soldMatch) totalAmount = toNum(soldMatch[1]);

  // explicit "total = 230" / "total amount 230"
  const totalMatch = text.match(TOTAL_RE);
  if (totalMatch) totalAmount = toNum(totalMatch[1]);

  // Need a cost, a total, or a quantity to be a real order record.
  // Price-less inquiries like "can i get 500 grams laddu" are orders too.
  if (costPrice == null && totalAmount == null && quantity == null) return null;

  // Derive missing values
  if (costPrice != null && profitPercent != null && profitAmount == null) {
    profitAmount = round2((costPrice * profitPercent) / 100);
  }
  if (costPrice != null && totalAmount == null && profitAmount != null) {
    totalAmount = round2(costPrice + profitAmount);
  }
  if (totalAmount != null && costPrice != null && profitAmount == null) {
    profitAmount = round2(totalAmount - costPrice);
  }
  if (costPrice != null && profitAmount != null && profitPercent == null && costPrice > 0) {
    profitPercent = round2((profitAmount / costPrice) * 100);
  }
  if (totalAmount == null && costPrice != null && profitAmount == null) {
    totalAmount = costPrice; // break-even / unknown margin
  }

  return {
    customer,
    item,
    quantity,
    unit,
    costPrice,
    profitPercent,
    profitAmount,
    totalAmount,
    source: 'regex',
    raw: text,
  };
}

module.exports = { parseOrder };
