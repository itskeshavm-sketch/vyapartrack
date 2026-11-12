package com.vyapartrack.app;

// Order regex parser - Java port of src/parser.js (kept in sync manually).
// Handles messy Hinglish / informal messages like:
//   "Order from Mayank, 500 grams ladoo, +15% profit, total cost of ladoo=200 rupees"
//   "sold 1kg kaju katli to sharma uncle, cost 850, profit 20%"
//   "ravi kirana ne 5kg namkeen mange, cost 400, profit 18%"
// plus native-script (Devanagari, Bengali, Tamil, Telugu, Kannada, Malayalam,
// Gujarati, Gurmukhi, Urdu) quantities and intents.

import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class JavaParser {

    private JavaParser() {}

    private static final String UNITS = "kg|kgs|kilogram|kilograms|kilo|kilos|keji|gram|grams|graam|gms|gm|g|dozen|darjan|pcs|pieces|piece|pees|pis|pc|nag|ml|millilitre|millilitres|milliliter|milliliters|litre|litres|liter|liters|l|ser|seer|sher|pav|paav|poa|tola|thola|tol|ratti|chatak|chhatank|masha|vori|ennam|ennikkai|mukka|item|ta";

    private static final Pattern QUANTITY_RE = Pattern.compile("(\\d+(?:\\.\\d+)?)\\s*(" + UNITS + ")\\b", Pattern.CASE_INSENSITIVE);
    // Bare number with no unit ("10 laddu chahiye") - only a quantity when an
    // order-intent word is present; price/profit/total numbers never qualify.
    private static final Pattern BARE_NUMBER_RE = Pattern.compile("\\b\\d+(?:\\.\\d+)?\\b");
    private static final String UNIT_NOT_AFTER = "(?!\\s*(?:" + UNITS + ")\\b)";
    private static final Pattern COST_RE = Pattern.compile("(?:total\\s*)?(?:cost|cp|base\\s*price|buying\\s*price|price)\\s*(?:of\\s*[a-z ]+)?\\s*(?:[=:]|is|are)?\\s*(?:rs\\.?|rupees|inr|\u20B9)?\\s*(\\d+(?:\\.\\d+)?)", Pattern.CASE_INSENSITIVE);
    private static final Pattern SOLD_FOR_RE = Pattern.compile("\\b(?:sold|sell|selling)\\b\\s*(?:it\\s*)?(?:at|for|in|to\\s+\\w+)?\\s*(?:rs\\.?|rupees|inr|\u20B9)?\\s*(\\d+(?:\\.\\d+)?)\\b" + UNIT_NOT_AFTER, Pattern.CASE_INSENSITIVE);
    private static final Pattern PROFIT_PCT_RE = Pattern.compile("\\+?\\s*(\\d+(?:\\.\\d+)?)\\s*%");
    private static final Pattern PROFIT_PCT_WORD_RE = Pattern.compile("(?:profit|margin)\\s*(?:is|=|:|of|@)?\\s*(\\d+(?:\\.\\d+)?)\\s*%", Pattern.CASE_INSENSITIVE);
    private static final Pattern PROFIT_AMT_RE = Pattern.compile("(?:profit|margin)\\s*(?:is|=|:|of)?\\s*(?:rs\\.?|rupees|inr|\u20B9)?\\s*(\\d+(?:\\.\\d+)?)\\b(?!\\s*%)", Pattern.CASE_INSENSITIVE);
    private static final Pattern TOTAL_RE = Pattern.compile("total\\s*(?:amount|price|sell(?:ing)?)?\\s*(?:[=:]|is)?\\s*(?:rs\\.?|rupees|inr|\u20B9)?\\s*(\\d+(?:\\.\\d+)?)", Pattern.CASE_INSENSITIVE);

    // Fractional spoken quantities: "aadha kilo besan", "dedh kg doodh"...
    private static final Pattern FRACTION_QTY_RE = Pattern.compile("\\b(aadha|adha|ardha|half|dedh|dhai|sava|savva)\\s*(kilo|kilos|kg|keji|gram|litre|liter)\\b", Pattern.CASE_INSENSITIVE);
    private static final Map<String, Double> FRACTION_VALUES = new HashMap<>();
    static {
        FRACTION_VALUES.put("aadha", 0.5); FRACTION_VALUES.put("adha", 0.5);
        FRACTION_VALUES.put("ardha", 0.5); FRACTION_VALUES.put("half", 0.5);
        FRACTION_VALUES.put("dedh", 1.5);  FRACTION_VALUES.put("dhai", 1.5);
        FRACTION_VALUES.put("sava", 1.25); FRACTION_VALUES.put("savva", 1.25);
    }

    // Order intent, Roman script: safe single words + distinctive phrases.
    private static final String ROMAN_INTENT_1 =
        "\\b(?:order(?:ed|s)?|sold|sale|sell|bill|invoice|mangwaya|mange|mangaye|chahiye|bhejo|bhejna|bhej|kitna|kitne|mujhe|pahije|chai|kavali|beku|venam|venum|chahida|joie|kalisi|kaluhisi|anuppunga|pampandi)\\b";
    private static final String ROMAN_INTENT_2 =
        "\\b(?:bana do|bana dena|de do|de dena|bhej do|bhej dena|taiyar kar do|tayar kar do|pack kar do|pack kar dena|ghar bhej|kitne ka|kitne mein|kitna lagega|rate kya|bhav batao|price batao|bhao kya|qeemat kya|total kitna|kiti padel|kiti hoil|kiti rupayala|bhav kay|rate sanga|kimmat sanga|total kiti|pathavun dya|banvun dya|tayar karun|pack karun|ghari pathva|koto porbe|koto hobe|dam koto|rate koto|total koto|koto taka|pathiye din|baniye din|toiri kore din|ready kore din|pack kore din|rekhe din|senju kudunga|ready pannunga|pack pannunga|veetukku anuppunga|evlo aagum|evlo varum|rate enna|price enna|vilai enna|total evlo|pampincheyandi|ivvandi|ichcheyandi|chesi ivvandi|tayaru cheyandi|ready cheyandi|pack cheyandi|entha avutundi|entha padutundi|rate entha|price entha|dhara entha|total entha|manege kalisi|tayarisi kodi|ittu kodi|madi kodi|ready madi|pack madi|eshtu agutte|eshtu barutte|bele eshtu|rate eshtu|price eshtu|total eshtu|ayachu tharu|ayach tharu|veettil ayakku|cheithu tharu|undakki tharu|ready aakki|pack cheythu|ethra aakum|ethra varum|vila ethra|rate ethra|price ethra|total ethra|ethra roopa|mokli do|mokli aapo|aapi do|aapi aapo|banavi aapo|taiyar kari aapo|ready kari do|pack kari do|rakhi do|ghare mokli|ketla thashe|ketlama malse|bhav ketlo|rate ketlo|ketlu padse|total ketlu|ketla rupiya|bhej deo|de deo|bana deo|tyaar kar deo|ready kar deo|pack kar deo|rakh deo|kinne da pavega|kinne nu milega|rate ki aa|bhav ki aa|price kinne di|kinne da aa|total kinna|kinne paise|bhej dein|de dein|bana dein|tayyar kar dein|kitne ka hoga|delivery kar do|delivery kore din|delivery pannunga|delivery cheyandi|delivery madi|delivery kari do)\\b";
    private static final String ROMAN_INTENT_3 =
        "(?:can|may)\\s+i\\s+(?:get|have|order)|i\\s+(?:want|need)\\b";
    private static final Pattern ROMAN_INTENT_RE = Pattern.compile(ROMAN_INTENT_1 + "|" + ROMAN_INTENT_2 + "|" + ROMAN_INTENT_3, Pattern.CASE_INSENSITIVE);

    // ---- Native-script support ----
    private static final String NATIVE_DIGITS =
        "०१२३४५६७८९০১২৩৪৫৬৭৮৯௦௧௨௩௪௫௬௭௮௯౦౧౨౩౪౫౬౭౮౯೦೧೨೩೪೫೬೭೮೯൦൧൨൩൪൫൬൭൮൯੦੧੨੩੪੫੬੭੮੯۰۱۲۳۴۵۶۷۸۹";
    private static final Map<Character, String> DIGIT_MAP = new HashMap<>();
    static {
        for (int c = 0; c < NATIVE_DIGITS.length(); c += 10) {
            for (int i = 0; i < 10; i++) {
                DIGIT_MAP.put(NATIVE_DIGITS.charAt(c + i), String.valueOf(i));
            }
        }
    }

    private static String normalizeDigits(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            String d = DIGIT_MAP.get(s.charAt(i));
            sb.append(d != null ? d : s.charAt(i));
        }
        return sb.toString();
    }

    private static final String[] NATIVE_INTENT = {
        "चाहिए", "भेज दो", "भेज देना", "भेजो", "बना दो", "बना देना", "दे दो", "दे देना",
        "तैयार कर दो", "तैयार कर देना", "पैक कर दो", "पैक कर देना", "पैक करके भेज दो",
        "रख देना", "डिलीवर कर दो", "घर भेज", "कितने का", "कितने में", "कितना लगेगा",
        "भाव बताओ", "रेट क्या", "प्राइस बताओ", "टोटल कितना", "ऑर्डर",
        "بھیج دو", "بھیج دیں", "بنا دو", "بنا دیں", "تیار کر دو", "پیک کر دو", "گھر بھیج",
        "کتنے کا", "کتنے میں", "کتنا لگے گا", "قیمت کیا", "بھاؤ کیا", "ٹوٹل کتنا", "آرڈر", "چاہیے",
        "पाहिजे", "पाठवा", "पाठवून द्या", "बनवून द्या", "तयार करून", "पॅक करून",
        "किती पडेल", "किती होईल", "भाव काय", "रेट सांगा", "किंमत सांगा", "टोटल किती",
        "চাই", "অর্ডার", "পাঠিয়ে দিন", "বানিয়ে দিন", "তৈরি করে দিন",
        "রেখে দিন", "প্যাক করে দিন", "কত পড়বে", "কত হবে", "দাম কত", "কত টাকা", "টোটাল কত",
        "வேண்டும்", "ஆர்டர்", "அனுப்புங்க", "அனுப்பி விடுங்க", "செஞ்சு குடுங்க",
        "ரெடி பண்ணுங்க", "பேக் பண்ணுங்க", "வீட்டுக்கு அனுப்புங்க",
        "எவ்வளவு ஆகும்", "எவ்வளவு வரும்", "ரேட் என்ன", "விலை என்ன", "டோட்டல் எவ்வளவு",
        "కావాలి", "ఆర్డర్", "పంపండి", "పంపించేయండి", "ఇవ్వండి", "ఇచ్చేయండి",
        "తయారు చేయండి", "రెడీ చేయండి", "ప్యాక్ చేయండి",
        "ఎంత అవుతుంది", "ఎంత పడుతుంది", "రేట్ ఎంత", "ధర ఎంత", "టోటల్ ఎంత",
        "ಬೇಕು", "ಆರ್ಡರ್", "ಕಳಿಸಿ", "ಕಳುಹಿಸಿ", "ಮನೆಗೆ ಕಳಿಸಿ", "ತಯಾರಿಸಿ ಕೊಡಿ",
        "ಇಟ್ಟು ಕೊಡಿ", "ರೆಡಿ ಮಾಡಿ", "ಪ್ಯಾಕ್ ಮಾಡಿ",
        "ಎಷ್ಟು ಆಗುತ್ತೆ", "ಎಷ್ಟು ಬರುತ್ತೆ", "ಬೆಲೆ ಎಷ್ಟು", "ರೇಟ್ ಎಷ್ಟು", "ಟೋಟಲ್ ಎಷ್ಟು",
        "വേണം", "ഓർഡർ", "അയച്ചു തരൂ", "അയക്കൂ", "ചെയ്ത് തരൂ", "ഉണ്ടാക്കി തരൂ",
        "പാക്ക് ചെയ്ത് തരൂ", "വീട്ടിൽ അയക്കൂ",
        "എത്ര ആകും", "എത്ര വരും", "വില എത്ര", "റേറ്റ് എത്ര", "ടോട്ടൽ എത്ര",
        "જોઈએ", "ઓર્ડર", "મોકલી દો", "મોકલી આપો", "આપી દો", "આપી આપો", "બનાવી આપો",
        "તૈયાર કરી", "રેડી કરી", "પેક કરી", "રાખી દો",
        "કેટલા થશે", "કેટલું પડશે", "ભાવ કેટલો", "રેટ કેટલો", "ટોટલ કેટલું",
        "ਚਾਹੀਦਾ", "ਆਰਡਰ", "ਭੇਜ ਦਿਓ", "ਬਣਾ ਦਿਓ", "ਤਿਆਰ ਕਰ ਦਿਓ", "ਰੈਡੀ ਕਰ ਦਿਓ",
        "ਪੈਕ ਕਰ ਦਿਓ", "ਰੱਖ ਦਿਓ", "ਕਿੰਨੇ ਦਾ", "ਕਿੰਨੇ ਪੈਸੇ", "ਰੇਟ ਕੀ", "ਭਾਅ ਕੀ", "ਟੋਟਲ ਕਿੰਨਾ",
    };
    private static final String[] NATIVE_UNITS = {
        "किलो", "केजी", "किलोग्राम", "किलोग्रॅम", "কিলো", "কেজি", "কিলোগ্রাম", "கிலோ", "கிலோகிராம்",
        "కిలో", "కిలోగ్రామ్", "కేజీ", "ಕಿಲೋ", "ಕಿಲೋಗ್ರಾಂ", "ಕೆಜಿ", "കിലോ", "കിലോഗ്രാം",
        "કિલો", "કિલોગ્રામ", "ਕਿਲੋ", "ਕਿਲੋਗ੍ਰਾਮ", "ਕੇਜੀ", "کلو", "کلوگرام",
        "ग्राम", "ग्रॅम", "গ্রাম", "கிராம்", "గ్రాము", "ಗ್ರಾಂ", "ಗ್ರಾಮ", "ഗ്രാം", "ગ્રામ", "ਗ੍ਰਾਮ", "گرام",
        "तोला", "तोळा", "तोळ", "रत्ती", "छटांक", "চটক", "ভরি", "তোলা", "தோலா", "தோலை",
        "తులం", "తులా", "ತೊಲ", "ತೊಲೆ", "ರತ್ತಿ", "തൊല", "രത്തി", "તોલા", "તોલ", "રતી",
        "ਤੋਲਾ", "ਤੋਲ", "ਰੱਤੀ", "تولہ", "تول", "رتی", "ماشہ",
        "लिटर", "লিটার", "லிட்டர்", "లీటర్", "ಲೀಟರ್", "ലിറ്റർ", "લીટર", "ਲੀਟਰ", "لیٹر",
        "मिलीलीटर", "मिली",
        "पीस", "नग", "পিস", "টা", "பீஸ்", "పీస్", "ముక్క", "ಪೀಸ್", "ಐಟಂ", "എണ്ണം", "પીસ", "નંગ", "ਪੀਸ", "ਨਗ", "پیس", "عدد",
        "दर्जन", "डझन", "ডজন", "டஜன்", "డజన్", "ಡಜನ್", "ഡസൻ", "ડઝન", "ਦਰਜਨ", "درجن",
        "కిలోలు", "కిలోల", "గ్రాములు", "గ్రాముల", "లీటర్లు", "డజన్లు",
        "सेर", "शेर", "সের", "পোয়া", "சேர்", "படி", "సేరు", "ಸೇರು", "സേർ", "શેર", "ਸੇਰ", "سیر",
        "पाव", "பாவு", "పావు", "ಪಾವು", "പാവ്", "પાવ", "ਪਾਵ", "پاؤ",
    };
    private static final Map<String, String> NATIVE_UNIT_MAP = new HashMap<>();
    static {
        String[][] groups = {
            {"किलो केजी किलोग्राम किलोग्रॅम কিলো কেজি কিলোগ্রাম கிலோ கிலோகிராம் కిలో కిలోగ్రామ్ కేజీ ಕಿಲೋ ಕಿಲೋಗ್ರಾಂ ಕೆಜಿ കിലോ കിലോഗ്രാം કિલો કિલોગ્રામ ਕਿਲੋ ਕਿਲੋਗ੍ਰਾਮ ਕੇਜੀ کلو کلوگرام", "kg"},
            {"ग्राम ग्रॅम গ্রাম கிராம் గ్రాము ಗ್ರಾಂ ಗ್ರಾಮ ഗ്രാം ગ્રામ ਗ੍ਰਾਮ گرام तोला तोळा तोळ रत्ती छटांक ভরি তোলা தோலா தோலை తులం తులా ತೊಲ ತೊಲೆ ರತ್ತಿ തൊല രത്തി તોલા તોલ રતી ਤੋਲਾ ਤੋਲ ਰੱਤੀ تولہ تول رتی ماشہ", "g"},
            {"लीटर লিটার லிட்டர் లీటర్ ಲೀಟರ್ ലിറ്റർ લીટર ਲੀਟਰ لیٹر", "l"},
            {"मिलीलीटर मिली", "ml"},
            {"पीस नग পিস টা பீஸ் పీస్ ముక్క ಪೀಸ್ ಐಟಂ എണ്ണം પીસ નંગ ਪੀਸ ਨਗ پیس عدد", "pcs"},
            {"दर्जन डझन ডজন டஜன் డజన్ ಡಜನ್ ഡസൻ ડઝન ਦરજન درجن", "dozen"},
            {"కిలోలు కిలోల గ్రాములు గ్రాముల లీటర్లు డజన్లు", "dozen"},
            {"सेर शेर সের পোয়া சேர் படி సేరు ಸೇರು സേർ શેર ਸੇਰ سیر पाव பாவு పావు పావు പാവ് પાવ ਪਾਵ پاؤ", "kg"},
        };
        for (String[] g : groups) {
            for (String w : g[0].split(" ")) {
                if (!w.isEmpty()) NATIVE_UNIT_MAP.put(w, g[1]);
            }
        }
    }

    private static final String B = "(?<![\\p{L}\\p{M}])";
    private static final String A = "(?![\\p{L}\\p{M}])";
    private static final Pattern NATIVE_INTENT_RE = Pattern.compile(B + "(?:" + String.join("|", NATIVE_INTENT) + ")" + A);
    private static final Pattern NATIVE_QUANTITY_RE = Pattern.compile(B + "([" + NATIVE_DIGITS + "]+)\\s*(" + String.join("|", NATIVE_UNITS) + ")" + A);
    private static final Pattern MIXED_QUANTITY_RE = Pattern.compile(B + "(\\d+(?:\\.\\d+)?)\\s*(" + String.join("|", NATIVE_UNITS) + ")" + A);
    private static final Pattern NATIVE_FRACTION_RE = Pattern.compile(B + "(आधा|अर्धा|आर्धा|सवा|डेढ़|ढाई)\\s*(किलो|केजी|ग्राम|लीटर)" + A);
    private static final Map<String, Double> NATIVE_FRACTION_VALUES = new HashMap<>();
    static {
        NATIVE_FRACTION_VALUES.put("आधा", 0.5); NATIVE_FRACTION_VALUES.put("अर्धा", 0.5);
        NATIVE_FRACTION_VALUES.put("आर्धा", 0.5); NATIVE_FRACTION_VALUES.put("सवा", 1.25);
        NATIVE_FRACTION_VALUES.put("डेढ़", 1.5); NATIVE_FRACTION_VALUES.put("ढाई", 2.5);
    }
    private static final String[] NATIVE_ITEM_TAILS = {
        "चाहिए", "भेज दो", "भेज देना", "दे दो", "दे देना", "बना दो", "बना देना", "रख दो", "पैक कर दो", "तैयार कर दो", "घर भेज", "डिलीवर कर दो", "पाहिजे", "पाठवा", "पाठवून द्या", "বানিয়ে দিন", "তৈরি করে দিন", "রেখে দিন", "প্যাক করে দিন", "পাঠিয়ে দিন", "வேண்டும்", "அனுப்புங்க", "குடுங்க", "செஞ்சு குடுங்க", "ரெடி பண்ணுங்க", "பேக் பண்ணுங்க", "కావాలి", "పంపండి", "ఇవ్వండి", "తయారు చేయండి", "రెడీ చేయండి", "ప్యాక్ చేయండి", "ಬೇಕು", "ಕಳಿಸಿ", "ಕೊಡಿ", "ತಯಾರಿಸಿ ಕೊಡಿ", "ರೆಡಿ ಮಾಡಿ", "ಪ್ಯಾಕ್ ಮಾಡಿ", "വേണം", "തരൂ", "അയക്കൂ", "ചെയ്ത് തരൂ", "ഉണ്ടാക്കി തരൂ", "പാക്ക് ചെയ്ത് തരൂ", "જોઈએ", "મોકલી દો", "આપી દો", "બનાવી આપો", "તૈયાર કરી આપો", "રેડી કરી દો", "પેક કરી દો", "રાખી દો", "ਚਾਹੀਦਾ", "ਭੇਜ ਦਿਓ", "ਦੇ ਦਿਓ", "ਬਣਾ ਦਿਓ", "ਤਿਆਰ ਕਰ ਦਿਓ", "ਪੈਕ ਕਰ ਦਿਓ", "ਰੱਖ ਦਿਓ", "چاہیے", "بھیج دو", "دے دو", "بنا دو", "تیار کر دو", "پیک کر دو", "گھر بھیج دو",
    };
    private static final Pattern NATIVE_ITEM_TAIL_RE = Pattern.compile("\\s*(?:" + String.join("|", NATIVE_ITEM_TAILS) + ")" + A + ".*$");

    // Customer name: tried in priority order, first match wins
    private static final Pattern[] CUSTOMER_RES = {
        Pattern.compile("order\\s*from\\s+([A-Za-z][A-Za-z .]{1,30}?)(?=\\s*[,.!]|$|\\s+\\d|\\s+cost|\\s+price|\\s+profit|\\s+\\+)", Pattern.CASE_INSENSITIVE),
        Pattern.compile("(?:customer|client)\\s*[:\\-]\\s*([A-Za-z][A-Za-z .]{1,30}?)(?=\\s*[,.!]|$|\\s+\\d|\\s+cost|\\s+price|\\s+profit)", Pattern.CASE_INSENSITIVE),
        Pattern.compile("\\bsold\\b[^,.]*?\\bto\\s+([A-Za-z][A-Za-z .]{1,30}?)(?=\\s*[,.!]|$|\\s+\\d|\\s+cost|\\s+price|\\s+profit)", Pattern.CASE_INSENSITIVE),
        Pattern.compile("\\bfor\\s+([A-Za-z][A-Za-z .]{1,30}?)(?=\\s*[,.!]|$|\\s+\\d|\\s+cost|\\s+price|\\s+profit)", Pattern.CASE_INSENSITIVE),
        Pattern.compile("\\b([A-Za-z][A-Za-z ]{1,30}?)\\s+ne\\b", Pattern.CASE_INSENSITIVE),
    };

    private static final Map<String, String> UNIT_NORMALIZE = new HashMap<>();
    static {
        String[][] m = {
            {"kg", "kg"}, {"kgs", "kg"}, {"kilogram", "kg"}, {"kilograms", "kg"}, {"kilo", "kg"}, {"kilos", "kg"}, {"keji", "kg"},
            {"gram", "g"}, {"grams", "g"}, {"graam", "g"}, {"gms", "g"}, {"gm", "g"}, {"g", "g"},
            {"dozen", "dozen"}, {"darjan", "dozen"},
            {"pcs", "pcs"}, {"pieces", "pcs"}, {"piece", "pcs"}, {"pees", "pcs"}, {"pis", "pcs"}, {"pc", "pcs"}, {"nag", "pcs"},
            {"ennam", "pcs"}, {"ennikkai", "pcs"}, {"mukka", "pcs"}, {"item", "pcs"}, {"ta", "pcs"},
            {"litre", "l"}, {"litres", "l"}, {"liter", "l"}, {"liters", "l"}, {"l", "l"},
            {"ml", "ml"}, {"millilitre", "ml"}, {"millilitres", "ml"}, {"milliliter", "ml"}, {"milliliters", "ml"},
            {"ser", "kg"}, {"seer", "kg"}, {"sher", "kg"}, {"pav", "kg"}, {"paav", "kg"}, {"poa", "kg"},
            {"tola", "g"}, {"thola", "g"}, {"tol", "g"}, {"ratti", "g"}, {"chatak", "g"}, {"chhatank", "g"}, {"masha", "g"}, {"vori", "g"},
        };
        for (String[] kv : m) UNIT_NORMALIZE.put(kv[0], kv[1]);
    }

    private static final Pattern ITEM_TAIL_STOP = Pattern.compile("\\s+(?:mange|mangwaya|mangaye|chahiye|bhejo|bhejna|bhej|dena|dein|deo|karo|krdo|please|ke\\s+liye|pahije|pathva|banvun|kavali|beku|venam|venum|chahida|joie|kalisi|kaluhisi|anuppunga|pampandi|kudunga|tharu|pathan|din|dya|venam|bana do|bana dena|de do|de dena|bhej do|bhej dena|taiyar kar do|pack kar do|pathavun dya|banvun dya|pathiye din|baniye din|pack kore din|rekhe din|ready pannunga|pack pannunga|pampincheyandi|ivvandi|ready cheyandi|pack cheyandi|ready madi|pack madi|ittu kodi|madi kodi|ayachu tharu|ayach tharu|cheithu tharu|undakki tharu|pack cheythu|mokli do|mokli aapo|aapi do|banavi aapo|ready kari do|pack kari do|rakhi do|bhej deo|bana deo|de deo|tyaar kar deo|ready kar deo|pack kar deo|rakh deo|bhej dein|de dein|bana dein|tayyar kar dein|delivery kar do)\\b.*$", Pattern.CASE_INSENSITIVE);

    // ---- False-positive guards (offline + deterministic) ----------------------
    // Port of the guards in src/parser.js - keep both files in sync.
    private static final Pattern ENQUIRY_RE = Pattern.compile(
        "\\b(?:kitne\\s*ka|kitna\\s*ka|kitne\\s*ka\\s*hoga|kitne\\s*mein|kitna\\s*lagega|rate\\s*kya|rate\\s*batao|price\\s*kya|price\\s*batao|bhav\\s*batao|bhao\\s*kya|qeemat\\s*kya|dam\\s*kya|mrityu\\s*kya|total\\s*kitna|total\\s*koto|total\\s*kiti|bhav\\s*kay|rate\\s*sanga|kimmat\\s*sanga|kinne\\s*da\\s*pavega|kinne\\s*nu\\s*milega|kinne\\s*da\\s*aa|kinne\\s*paise|total\\s*kinna|rate\\s*ki\\s*aa|bhav\\s*ki\\s*aa|price\\s*kinne\\s*di|rate\\s*koto|koto\\s*hobe|koto\\s*porbe|dam\\s*koto|koto\\s*taka)\\b",
        Pattern.CASE_INSENSITIVE);

    private static final String[] NATIVE_ENQUIRY = {
        "कितने का", "कितने में", "कितना लगेगा", "भाव बताओ", "रेट क्या", "प्राइस बताओ", "टोटल कितना",
        "किती पडेल", "किती होईल", "भाव काय", "रेट सांगा", "किंमत सांगा", "टोटल किती",
        "কত পড়বে", "কত হবে", "দাম কত", "কত টাকা", "টোটল কত",
        "எவ்வளவு ஆகும்", "எவ்வளவு வரும்", "ரேட் என்ன", "விலை என்ன", "டோட்டல் எவ்வளவு",
        "ఎంత అవుతుంది", "ఎంత పడుతుంది", "రేట్ ఎంత", "ధర ఎంత", "టోటల్ ఎంత",
        "ಎಷ್ಟು ಆಗುತ್ತೆ", "ಎಷ್ಟು ಬರುತ್ತೆ", "ಬೆಲೆ ಎಷ್ಟು", "ರೇಟ್ ಎಷ್ಟು", "ಟೋಟಲ್ ಎಷ್ಟು",
        "എത്ര ആകും", "എത്ര വരും", "വില എത്ര", "റേറ്റ് എത്ര", "ടോട്ടൽ എത്ര",
        "કેટલા થશે", "કેટલું પડશે", "ભાવ કેટલો", "રેટ કેટલો", "ટોટલ કેટલું",
        "ਕਿੰਨੇ ਦਾ", "ਕਿੰਨੇ ਪੈਸੇ", "ਰੇਟ ਕੀ", "ਭਾਅ ਕੀ", "ਟੋਟਲ ਕਿੰਨਾ",
        "کتنے کا", "کتنے میں", "کتنا لگے گا", "قیمت کیا", "بھاؤ کیا", "ٹوٹل کتنا",
    };
    private static final Pattern NATIVE_ENQUIRY_RE =
        Pattern.compile(B + "(?:" + String.join("|", NATIVE_ENQUIRY) + ")" + A);

    private static final Pattern TIME_RE = Pattern.compile(
        "\\b(?:meeting|meetings|reunion|appointment|reminder)\\b"
        + "|\\bat\\s+\\d{1,2}\\b(?!\\s*(?:kg|kgs|g|gm|gms|gram|grams|l|litre|litres|liter|ml|pcs|pieces|piece|pc|dozen|darjan|ta))"
        + "|\\b\\d{1,2}\\s*(?:baje|pm|am|o.clock)\\b"
        + "|\\b\\d+\\s*(?:minutes?|mins?|hours?|hrs?|seconds?|secs?)\\b",
        Pattern.CASE_INSENSITIVE);

    private static final Set<String> BAD_ITEM_WORDS = new HashSet<>(Arrays.asList(
        // time
        "minute", "minutes", "min", "mins", "hour", "hours", "hr", "hrs", "second", "seconds", "sec", "secs",
        "day", "days", "din", "dinon", "week", "weeks", "hafte", "month", "months", "mahina", "mahine",
        "year", "years", "saal", "baje", "ghanta", "ghante", "waqt", "time", "times",
        "meeting", "call", "appointment", "schedule", "birthday", "party", "invite",
        "morning", "evening", "raat", "subah", "sham",
        // prepositions
        "for", "from", "to", "in", "on", "at", "by", "with", "without", "of", "about", "after", "before",
        "until", "while", "per", "into", "onto", "upon", "via",
        // Hinglish particles / filler
        "ka", "ki", "ke", "ko", "se", "mein", "me", "par", "aur", "ya", "phir", "bhi", "hi", "tak",
        "wala", "wali", "wale", "walon", "waala", "jaldi", "abhi", "aaj", "kal", "parso",
        "sab", "sabhi", "thoda", "kam", "zyada", "bas", "sirf", "only", "please", "ready", "now", "then",
        "and", "or", "but", "not", "no", "so", "if", "as", "is", "am", "are", "was", "were",
        "the", "this", "that", "it", "i", "you", "he", "we", "they", "my", "our", "your", "us", "them", "out",
        "all", "any", "some", "does", "did", "have", "has", "had", "will", "would", "can", "could",
        "should", "may", "might", "must", "shall", "upto"
    ));

    /** True when the extracted item is made only of time words / filler. */
    private static boolean isBadItem(String item) {
        if (item == null) return false;
        String[] words = item.toLowerCase().split("[\\s,.;!?]+");
        int seen = 0;
        for (String w : words) {
            if (w.isEmpty()) continue;
            seen++;
            if (!BAD_ITEM_WORDS.contains(w)) return false;
        }
        return seen > 0;
    }

    private static Double toNum(String v) {
        if (v == null) return null;
        try {
            return Double.parseDouble(v.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static double round2(double n) {
        return Math.round(n * 100) / 100.0;
    }

    private static String titleCase(String name) {
        String[] words = name.toLowerCase().trim().split("\\s+");
        StringBuilder sb = new StringBuilder();
        for (String w : words) {
            if (w.isEmpty()) continue;
            if (sb.length() > 0) sb.append(' ');
            sb.append(Character.toUpperCase(w.charAt(0))).append(w.substring(1));
        }
        return sb.toString();
    }

    private static String extractCustomer(String text) {
        for (Pattern re : CUSTOMER_RES) {
            Matcher m = re.matcher(text);
            if (m.find() && m.group(1) != null) {
                String name = m.group(1).replaceAll("(?i)\\b(cost|price|profit|rs|rupees|total|ne)\\b\\s*$", "").trim();
                if (!name.isEmpty()) return titleCase(name);
            }
        }
        return null;
    }

    private static String extractItem(String text, Matcher qtyMatch) {
        int idx = qtyMatch.start();
        String before = text.substring(Math.max(0, idx - 40), idx);
        int afterStart = idx + qtyMatch.group(0).length();
        String after = text.substring(afterStart, Math.min(text.length(), afterStart + 40));
        Matcher m = Pattern.compile("^\\s*(?:ke\\s+|ka\\s+|ki\\s+|of\\s+)?([a-z][a-z ]{1,25}?)(?=\\s*[,.!=]|$|\\s+\\d|\\s+cost|\\s+price|\\s+profit|\\s+for|\\s+sold|\\s+to\\b|\\s+ne\\b)", Pattern.CASE_INSENSITIVE).matcher(after);
        if (m.find() && !m.group(1).trim().isEmpty()) {
            return m.group(1).trim()
                    .replaceAll(ITEM_TAIL_STOP.pattern(), "")
                    .replaceAll(NATIVE_ITEM_TAIL_RE.pattern(), "")
                    .replaceAll("\\s+", " ");
        }
        m = Pattern.compile("([a-z][a-z]{2,24})\\s*(?:ke|ka|ki|of)?\\s*$", Pattern.CASE_INSENSITIVE).matcher(before);
        if (m.find() && !m.group(1).trim().matches("(?i)^(from|order|total|cost|price|profit|for|sold|sell)$")) {
            return m.group(1).trim();
        }
        return null;
    }

    private static class Qty {
        Double quantity;
        String unit;
        Matcher match;
        boolean bare;
    }

    private static Qty matchQuantity(String text) {
        Matcher qm = QUANTITY_RE.matcher(text);
        if (qm.find()) {
            Qty q = new Qty();
            q.quantity = toNum(qm.group(1));
            q.unit = UNIT_NORMALIZE.get(qm.group(2).toLowerCase());
            q.match = qm;
            return q;
        }
        Matcher nq = NATIVE_QUANTITY_RE.matcher(text);
        if (nq.find()) {
            Qty q = new Qty();
            q.quantity = toNum(normalizeDigits(nq.group(1)));
            q.unit = NATIVE_UNIT_MAP.get(nq.group(2));
            q.match = nq;
            return q;
        }
        Matcher mq = MIXED_QUANTITY_RE.matcher(text);
        if (mq.find()) {
            Qty q = new Qty();
            q.quantity = toNum(mq.group(1));
            q.unit = NATIVE_UNIT_MAP.get(mq.group(2));
            q.match = mq;
            return q;
        }
        Matcher nfq = NATIVE_FRACTION_RE.matcher(text);
        if (nfq.find()) {
            Qty q = new Qty();
            q.quantity = NATIVE_FRACTION_VALUES.get(nfq.group(1));
            q.unit = NATIVE_UNIT_MAP.get(nfq.group(2));
            q.match = nfq;
            return q;
        }
        Matcher fq = FRACTION_QTY_RE.matcher(text);
        if (fq.find()) {
            Qty q = new Qty();
            q.quantity = FRACTION_VALUES.get(fq.group(1).toLowerCase());
            q.unit = UNIT_NORMALIZE.get(fq.group(2).toLowerCase());
            q.match = fq;
            return q;
        }
        // Bare number, no unit: "bhai 10 laddu chahiye". Numbers already claimed
        // by a price/profit/total pattern ("cost 60", "total 230") never qualify.
        Qty bare = matchBareNumber(text);
        if (bare != null) return bare;
        return null;
    }

    private static Qty matchBareNumber(String text) {
        java.util.List<int[]> taken = new java.util.ArrayList<>();
        Pattern[] priceRes = {COST_RE, SOLD_FOR_RE, PROFIT_PCT_RE, PROFIT_PCT_WORD_RE, PROFIT_AMT_RE, TOTAL_RE};
        for (Pattern re : priceRes) {
            Matcher m = re.matcher(text);
            if (m.find() && m.group(1) != null) {
                int at = m.group(0).indexOf(m.group(1));
                if (at >= 0) taken.add(new int[]{m.start() + at, m.start() + at + m.group(1).length()});
            }
        }
        Matcher m = BARE_NUMBER_RE.matcher(text);
        while (m.find()) {
            int s = m.start(), e = m.end();
            boolean clash = false;
            for (int[] span : taken) {
                if (s < span[1] && e > span[0]) { clash = true; break; }
            }
            if (clash) continue;
            Qty q = new Qty();
            q.quantity = toNum(m.group(0));
            q.unit = null;
            q.match = m;
            q.bare = true;
            return q;
        }
        return null;
    }

    /**
     * Parse a WhatsApp message into a structured order JSON object.
     * Returns null when the message does not look like an order.
     */
    public static JSONObject parse(String text) {
        if (text == null || text.isEmpty()) return null;
        String customer = extractCustomer(text);

        Qty qty = matchQuantity(text);
        Double quantity = qty != null ? qty.quantity : null;
        String unit = qty != null ? qty.unit : null;
        String item = qty != null ? extractItem(text, qty.match) : null;

        // ---- false-positive guards (same rules as src/parser.js) ----
        // 1. A price question is an enquiry, not an order - unless the message
        //    also carries a real price figure, which makes it a sale.
        boolean hasMoney = COST_RE.matcher(text).find() || PROFIT_PCT_RE.matcher(text).find()
                || PROFIT_PCT_WORD_RE.matcher(text).find() || PROFIT_AMT_RE.matcher(text).find()
                || TOTAL_RE.matcher(text).find();
        if (!hasMoney && (ENQUIRY_RE.matcher(text).find() || NATIVE_ENQUIRY_RE.matcher(text).find())) return null;
        // 2. The number is a time, not a quantity ("I need 5 minutes", "meeting at 5").
        if (unit == null && TIME_RE.matcher(text).find()) return null;
        // 3. The extracted item is a time word or filler ("1kg wala?").
        if (isBadItem(item)) return null;
        // 4. A bare number with no product at all ("sold my bike for 40000").
        if (qty != null && qty.bare && (item == null || item.trim().isEmpty())) return null;

        // Bare "500g sugar" (quantity + item, no intent word) is an order too.
        // A bare number ("10 laddu") counts only with an intent word ("chahiye").
        boolean hasIntent = ROMAN_INTENT_RE.matcher(text).find() || NATIVE_INTENT_RE.matcher(text).find();
        boolean bareOrder = quantity != null && item != null && !item.trim().isEmpty() && (!(qty != null && qty.bare) || hasIntent);
        if (!hasIntent && !bareOrder) return null;

        Double costPrice = null, totalAmount = null, profitPercent = null, profitAmount = null;

        Matcher cm = COST_RE.matcher(text);
        if (cm.find()) costPrice = toNum(cm.group(1));

        Matcher pd = PROFIT_PCT_RE.matcher(text);
        Matcher pw = PROFIT_PCT_WORD_RE.matcher(text);
        if (pd.find()) profitPercent = toNum(pd.group(1));
        else if (pw.find()) profitPercent = toNum(pw.group(1));

        Matcher pa = PROFIT_AMT_RE.matcher(text);
        if (pa.find()) profitAmount = toNum(pa.group(1));

        // "sold ... for 800" -> selling price (total), but never the quantity itself
        Matcher sm = SOLD_FOR_RE.matcher(text);
        if (sm.find()) totalAmount = toNum(sm.group(1));

        // explicit "total = 230" / "total amount 230"
        Matcher tm = TOTAL_RE.matcher(text);
        if (tm.find()) totalAmount = toNum(tm.group(1));

        // Need a cost, a total, or a quantity to be a real order record.
        if (costPrice == null && totalAmount == null && quantity == null) return null;

        // Derive missing values
        if (costPrice != null && profitPercent != null && profitAmount == null) {
            profitAmount = round2(costPrice * profitPercent / 100.0);
        }
        if (costPrice != null && totalAmount == null && profitAmount != null) {
            totalAmount = round2(costPrice + profitAmount);
        }
        if (totalAmount != null && costPrice != null && profitAmount == null) {
            profitAmount = round2(totalAmount - costPrice);
        }
        if (costPrice != null && profitAmount != null && profitPercent == null && costPrice > 0) {
            profitPercent = round2(profitAmount / costPrice * 100.0);
        }
        if (totalAmount == null && costPrice != null && profitAmount == null) {
            totalAmount = costPrice; // break-even / unknown margin
        }

        JSONObject o = new JSONObject();
        try {
            o.putOpt("customer", customer);
            o.putOpt("item", item);
            o.putOpt("quantity", quantity);
            o.putOpt("unit", unit);
            o.putOpt("costPrice", costPrice);
            o.putOpt("profitPercent", profitPercent);
            o.putOpt("profitAmount", profitAmount);
            o.putOpt("totalAmount", totalAmount);
            o.put("source", "regex");
            o.put("raw", text);
        } catch (Exception ignored) {}
        return o;
    }
}
