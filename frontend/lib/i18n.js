// Interface language: English or Hindi.
//
// Aimed at the screens used at the mine by people who may not read English
// comfortably -- a worker filing a grievance or checking in, anyone
// reporting an incident, an inspector recording a finding. Oversight
// screens stay in English, the working language of the returns they read.
//
// Statutory names (DGMS, Mines Act, CMR 2017) and data values stay as they
// are in both languages: a worker who has to raise something with an
// official needs the term the official will recognise.
//
// The choice is remembered on the device, so a shared phone at a pit-head
// office keeps the last language used.
import { createContext, useContext, useEffect, useState } from "react";

const STRINGS = {
  // Navigation
  "nav.myMine": ["My mine", "मेरी खदान"],
  "nav.attendance": ["Attendance", "हाज़िरी"],
  "nav.incidents": ["Incidents", "दुर्घटनाएँ"],
  "nav.inspections": ["Inspections", "निरीक्षण"],
  "nav.actions": ["Corrective actions", "सुधारात्मक कार्रवाई"],
  "nav.operations": ["Production & environment", "उत्पादन और पर्यावरण"],
  "nav.returns": ["Statutory returns", "वैधानिक रिटर्न"],
  "nav.audit": ["Audit trail", "ऑडिट ट्रेल"],
  "nav.contractors": ["Contractors", "ठेकेदार"],
  "nav.mineOps": ["Mine operations", "खदान संचालन"],
  "nav.overview": ["Overview", "अवलोकन"],
  "nav.oversight": ["Oversight", "निगरानी"],
  "nav.users": ["User access", "उपयोगकर्ता पहुँच"],
  "logout": ["Log out", "लॉग आउट"],
  "language": ["हिन्दी", "English"],

  // Common
  "save": ["Save", "सहेजें"],
  "cancel": ["Cancel", "रद्द करें"],
  "status": ["Status", "स्थिति"],
  "when": ["When", "कब"],
  "photo": ["Photo", "फ़ोटो"],
  "addPhoto": ["Add a photo", "फ़ोटो जोड़ें"],
  "changePhoto": ["Change photo", "फ़ोटो बदलें"],
  "removePhoto": ["Remove", "हटाएँ"],
  "location.getting": ["Getting your location.", "आपकी लोकेशन ली जा रही है।"],
  "location.refused": ["Location access was refused. Allow it and try again.",
                       "लोकेशन की अनुमति नहीं मिली। अनुमति दें और फिर से कोशिश करें।"],
  "location.none": ["This device can't provide a location.", "यह डिवाइस लोकेशन नहीं दे सकता।"],
  "savedOffline": ["Saved on this device. It will be sent when you have a signal.",
                   "इस डिवाइस पर सहेजा गया। नेटवर्क मिलते ही भेज दिया जाएगा।"],
  "noMine": ["No mine is assigned to your account. Ask an administrator to set one.",
             "आपके खाते से कोई खदान जुड़ी नहीं है। व्यवस्थापक से जोड़ने को कहें।"],

  // Worker page
  "worker.title": ["My mine", "मेरी खदान"],
  "worker.raise": ["Raise a grievance", "शिकायत दर्ज करें"],
  "worker.about": ["What is this about?", "यह किस बारे में है?"],
  "worker.describe": ["Describe the issue", "समस्या बताइए"],
  "worker.describeHint": ["Give as much detail as you can.", "जितना हो सके उतना विवरण दें।"],
  "worker.file": ["File grievance", "शिकायत दर्ज करें"],
  "worker.filing": ["Filing", "दर्ज हो रही है"],
  "worker.needText": ["Describe the issue before submitting.", "भेजने से पहले समस्या बताइए।"],
  "worker.filed": ["Filed. Your mine official can see it now.", "दर्ज हो गई। आपके खदान अधिकारी अब इसे देख सकते हैं।"],
  "worker.yours": ["Grievances you have filed", "आपकी दर्ज शिकायतें"],
  "worker.filedOn": ["Filed", "दर्ज की"],
  "worker.category": ["Category", "श्रेणी"],
  "worker.detail": ["Detail", "विवरण"],
  "worker.outcome": ["Outcome", "परिणाम"],
  "worker.beingLooked": ["Being looked at", "जाँच जारी है"],
  "worker.escalated": ["Escalated for review", "समीक्षा के लिए आगे भेजी गई"],
  "worker.none": ["You haven't filed anything yet. Use the form above to raise an issue.",
                  "आपने अभी तक कोई शिकायत दर्ज नहीं की है। ऊपर दिए फ़ॉर्म से दर्ज करें।"],
  "cat.Wages/Payment Delay": ["Wages/Payment Delay", "वेतन/भुगतान में देरी"],
  "cat.Safety Equipment Shortage": ["Safety Equipment Shortage", "सुरक्षा उपकरणों की कमी"],
  "cat.Housing/Welfare": ["Housing/Welfare", "आवास/कल्याण"],
  "cat.Working Hours": ["Working Hours", "काम के घंटे"],
  "cat.Harassment/Conduct": ["Harassment/Conduct", "उत्पीड़न/आचरण"],
  "cat.Medical Facility": ["Medical Facility", "चिकित्सा सुविधा"],
  "cat.Transport": ["Transport", "परिवहन"],

  // Attendance
  "att.title": ["Attendance", "हाज़िरी"],
  "att.checkIn": ["Check in", "चेक इन करें"],
  "att.checkOut": ["Check out", "चेक आउट करें"],
  "att.onSite": ["You are checked in", "आप चेक इन हैं"],
  "att.since": ["since", "से"],
  "att.shift": ["Shift", "पाली"],
  "att.notIn": ["You are not checked in.", "आप चेक इन नहीं हैं।"],
  "att.hint": ["Your location is recorded with each check-in and check-out, and compared with the mine's location.",
               "हर चेक इन और चेक आउट के साथ आपकी लोकेशन दर्ज होती है और खदान की लोकेशन से मिलाई जाती है।"],
  "att.done.in": ["Checked in.", "चेक इन हो गया।"],
  "att.done.out": ["Checked out.", "चेक आउट हो गया।"],
  "att.outside": ["This location is outside the mine's boundary, so it has been flagged for your mine official.",
                  "यह लोकेशन खदान की सीमा से बाहर है, इसलिए इसे आपके खदान अधिकारी के लिए चिह्नित किया गया है।"],
  "att.history": ["Your recent shifts", "आपकी हाल की पालियाँ"],
  "att.in": ["In", "आगमन"],
  "att.out": ["Out", "प्रस्थान"],
  "att.hours": ["Hours", "घंटे"],
  "att.place": ["Location check", "लोकेशन जाँच"],
  "att.atMine": ["At the mine", "खदान पर"],
  "att.away": ["Outside boundary", "सीमा से बाहर"],
  "att.unknown": ["Not recorded", "दर्ज नहीं"],
  "att.none": ["No shifts recorded yet.", "अभी तक कोई पाली दर्ज नहीं।"],

  // Incidents
  "inc.title": ["Incidents", "दुर्घटनाएँ"],
  "inc.report": ["Report an incident", "दुर्घटना की सूचना दें"],
  "inc.reportHint": ["Report anything that hurt someone or nearly did. Near misses matter: they are the warning before the accident.",
                     "जिससे किसी को चोट लगी हो या लगते-लगते बची हो, उसकी सूचना दें। बाल-बाल बचने की घटनाएँ भी ज़रूरी हैं — वे दुर्घटना से पहले की चेतावनी हैं।"],
  "inc.type": ["What happened?", "क्या हुआ?"],
  "inc.when": ["When did it happen?", "यह कब हुआ?"],
  "inc.where": ["Where exactly?", "ठीक कहाँ?"],
  "inc.whereHint": ["e.g. Bench 4, haul road bend", "जैसे बेंच 4, हॉल रोड का मोड़"],
  "inc.injured": ["People injured", "घायल लोग"],
  "inc.killed": ["People killed", "मृत लोग"],
  "inc.describe": ["Describe what happened", "बताइए क्या हुआ"],
  "inc.immediate": ["What was done straight away?", "तुरंत क्या किया गया?"],
  "inc.submit": ["Report incident", "सूचना भेजें"],
  "inc.sending": ["Sending", "भेजी जा रही है"],
  "inc.sent": ["Reported. The mine official has been alerted", "सूचना भेज दी गई। खदान अधिकारी को सूचित कर दिया गया है"],
  "inc.sentHigh": [", and so have corporate management and the regulator.", "; कॉर्पोरेट प्रबंधन और नियामक को भी।"],
  "inc.needText": ["Say what happened before sending.", "भेजने से पहले बताइए क्या हुआ।"],
  "type.Fatal Accident": ["Fatal accident", "घातक दुर्घटना"],
  "type.Serious Injury": ["Serious injury", "गंभीर चोट"],
  "type.Minor Injury": ["Minor injury", "मामूली चोट"],
  "type.Dangerous Occurrence": ["Dangerous occurrence", "ख़तरनाक घटना"],
  "type.Fire": ["Fire", "आग"],
  "type.Inundation": ["Inundation (flooding)", "जलप्लावन (पानी भरना)"],
  "type.Roof/Side Fall": ["Roof or side fall", "छत या दीवार का गिरना"],
  "type.Equipment Failure": ["Equipment failure", "उपकरण की ख़राबी"],
  "type.Near Miss": ["Near miss", "बाल-बाल बचे"],
  "type.Environmental Release": ["Environmental release", "पर्यावरणीय रिसाव"],

  // Inspector
  "insp.title": ["Inspections", "निरीक्षण"],
  "insp.record": ["Record an inspection", "निरीक्षण दर्ज करें"],
  "insp.observation": ["Observation", "अवलोकन"],
  "insp.severity": ["Severity", "गंभीरता"],
  "insp.notes": ["Notes", "टिप्पणी"],
  "insp.notesHint": ["What did you observe?", "आपने क्या देखा?"],
  "insp.submit": ["Record inspection", "निरीक्षण दर्ज करें"],
  "insp.recording": ["Recording", "दर्ज हो रहा है"],
  "insp.locHint": ["Your location is captured automatically when you record.",
                   "दर्ज करते समय आपकी लोकेशन अपने-आप ली जाती है।"],
  "insp.fromPaper": ["From a paper sheet", "काग़ज़ी शीट से"],
  "insp.recent": ["Recorded at this mine", "इस खदान पर दर्ज"],
};

const LangContext = createContext({ lang: "en", setLang: () => {}, t: (k) => k });

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState("en");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("cmg-lang");
      if (saved === "hi" || saved === "en") setLangState(saved);
    } catch { /* storage unavailable: stay in English */ }
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.lang = lang;
  }, [lang]);

  const setLang = (l) => {
    setLangState(l);
    try { window.localStorage.setItem("cmg-lang", l); } catch { /* not persisted */ }
  };

  // Unknown keys fall back to the key's English text if the key itself
  // is readable, so a missing translation shows English, never a blank.
  const t = (key) => {
    const entry = STRINGS[key];
    if (!entry) return key.includes(".") ? key.split(".").slice(1).join(".") : key;
    return lang === "hi" ? entry[1] : entry[0];
  };

  return <LangContext.Provider value={{ lang, setLang, t }}>{children}</LangContext.Provider>;
}

export const useT = () => useContext(LangContext);
