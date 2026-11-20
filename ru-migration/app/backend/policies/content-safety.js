const EMAIL_RE = /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}/iu;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()]+/iu;
const SOCIAL_DOMAIN_RE = /(?:^|[^\p{L}\d])(?:t\.me|vk\.com|telegram\.me|wa\.me|discord\.gg|instagram\.com|youtube\.com)(?:\/[^\s]*)?/iu;
const BARE_DOMAIN_RE = /(?:^|[^\p{L}\d])(?:[\p{L}\d](?:[\p{L}\d-]{0,61}[\p{L}\d])?\.)+(?:ru|рф|com|net|org|io|me|gg|info|site|online)(?:\/[^\s]*)?(?=$|[^\p{L}\d])/iu;
const HANDLE_RE = /(?<![\p{L}\p{N}])@[a-z0-9_]{3,32}\b/iu;
const STREET_ADDRESS_RE = /(?:^|[^\p{L}\p{N}])(?:ул(?:ица)?\.?|проспект|пр-т|переулок|пер\.?)\s+[\p{L}ё.-]{2,}(?:\s+[\p{L}ё.-]{2,}){0,4}\s*,?\s*(?:д\.?\s*)?\d{1,5}(?:\s*(?:корп(?:ус)?|стр(?:оение)?|кв(?:артира)?|подъезд)\.?\s*\d{1,5})?/iu;
const HOUSE_ADDRESS_RE = /(?:^|[^\p{L}\p{N}])(?:дом|д\.?|квартира|кв\.?|подъезд|адрес)\s*[\p{L}\d№.,/-]{0,40}\d{1,5}/iu;
const PHONE_RE = /(?<!\d)\+?\d(?:[ \t().-]*\d){9,14}(?!\d)/gu;
const POSTCODE_RE = /(?:почтов(?:ый|ого)\s+индекс|индекс)\s*[:№-]?\s*\d{6}\b/iu;

// Offline screening is only a reason to hold material for a trusted human;
// these rules never approve or reject safety-sensitive content by themselves.
const SENSITIVE_SAFETY_REVIEW_RULES = [
  { code: "self_harm_safety_review", pattern: /(?:самоубийств[\p{L}]*|суицид[\p{L}]*|самоповрежден[\p{L}]*|покончить\s+с\s+собой|(?:хочу|планирую|думаю)\s+(?:убить|лишить\s+жизни)\s+себя|режу\s+себя|порезал(?:а|и)?\s+себя)/iu },
  { code: "sexual_safety_review", pattern: /(?:сексуальн[\p{L}]*\s+(?:насили[\p{L}]*|домогательств[\p{L}]*|принуждени[\p{L}]*|эксплуатац[\p{L}]*)|изнасилован[\p{L}]*|непристойн[\p{L}]*\s+(?:предложени[\p{L}]*|прикосновени[\p{L}]*))/iu },
  { code: "violence_safety_review", pattern: /(?:насили[\p{L}]*|нападени[\p{L}]*|побо[\p{L}]*|избил[\p{L}]*|травл[\p{L}]*|буллинг)/iu },
];

const LOCAL_REVIEW_RULES = [
  { code: "targeted_harassment", pattern: /(?:(?:унизи(?:ть|л[аио]?|м)|оскорби(?:ть|л[аио]?|м)|трави(?:ть|л[аио]?|м)|высме(?:ять|ивать|ял[аио]?)|издева(?:ться|лся|лись))[\s\S]{0,120}(?:ученик[\p{L}]*|одноклассник[\p{L}]*|сотрудник[\p{L}]*|человек[\p{L}]*|него|неё|нее|ему|ей|тебя)|(?:ученик[\p{L}]*|одноклассник[\p{L}]*|сотрудник[\p{L}]*|человек[\p{L}]*)[\s\S]{0,120}(?:унизи(?:ть|л[аио]?|м)|оскорби(?:ть|л[аио]?|м)|трави(?:ть|л[аио]?|м)|высме(?:ять|ивать|ял[аио]?)|издева(?:ться|лся|лись)))/iu },
  { code: "negative_personal_call", pattern: /(?:(?:ты|тебя|тебе|ему|ей)\s+(?:полный\s+)?(?:идиот[\p{L}]*|туп(?:ой|ая|ое|ые)|урод[\p{L}]*|дурак[\p{L}]*|придур[\p{L}]*)|(?:напиши(?:те)?|отправ(?:ь|ьте|ляй|ляйте)|пиши(?:те)?)\s+(?:ему|ей|им|тебе)\s+(?:все\s+)?(?:неприятн[\p{L}]*|оскорбительн[\p{L}]*|груб[\p{L}]*)\s+(?:сообщени[\p{L}]*|слов[\p{L}]*))/iu },
  { code: "controlled_substances", pattern: /(?:^|[^\p{L}\p{N}])(?:наркот[\p{L}]*|мефедрон[\p{L}]*|спайс[\p{L}]*|закладк[\p{L}]*|героин[\p{L}]*|амфетамин[\p{L}]*|экстази[\p{L}]*|мдма|кокаин[\p{L}]*|снюс[\p{L}]*|насвай[\p{L}]*)(?=$|[^\p{L}\p{N}])/iu },
  { code: "nicotine_or_alcohol", pattern: /(?:^|[^\p{L}\p{N}])(?:сигарет[\p{L}]*|вейп[\p{L}]*|никотин[\p{L}]*|табак[\p{L}]*|кальян[\p{L}]*|алкогол[\p{L}]*|водк[\p{L}]*|пив[\p{L}]*|энергетик[\p{L}]*)(?=$|[^\p{L}\p{N}])/iu },
  { code: "restricted_or_adult_content", pattern: /(?:^|[^\p{L}\p{N}])(?:порно[\p{L}]*|интим[\p{L}]*|казино|ставк[\p{L}]*|оруж[\p{L}]*|пистолет[\p{L}]*|взрывчат[\p{L}]*|насили[\p{L}]*|травл[\p{L}]*|буллинг)(?=$|[^\p{L}\p{N}])/iu },
  { code: "serious_hate_or_threat", pattern: /(?:ненавист[\p{L}]*|дискриминац[\p{L}]*|угроз[\p{L}]*|убей|убить|расправ[\p{L}]*|расист[\p{L}]*|нацист[\p{L}]*)/iu },
];

function normalizeContactText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/\s*(?:\[at\]|\(at\)|\{at\}|собака)\s*/giu, "@")
    .replace(/\s*(?:\[dot\]|\(dot\)|\{dot\}|точка)\s*/giu, ".");
}

export function containsContactData(value) {
  const normalized = normalizeContactText(value);
  const withoutDates = normalized.replace(/(?:^|\D)\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?=\D|$)/gu, " ");

  if (
    EMAIL_RE.test(withoutDates) ||
    URL_RE.test(withoutDates) ||
    SOCIAL_DOMAIN_RE.test(withoutDates) ||
    BARE_DOMAIN_RE.test(withoutDates) ||
    HANDLE_RE.test(withoutDates) ||
    STREET_ADDRESS_RE.test(withoutDates) ||
    HOUSE_ADDRESS_RE.test(withoutDates) ||
    POSTCODE_RE.test(withoutDates)
  ) return true;

  PHONE_RE.lastIndex = 0;
  return PHONE_RE.test(withoutDates);
}

export function findLocalPolicyFlag(value) {
  const normalized = String(value ?? "").normalize("NFKC");
  for (const rule of SENSITIVE_SAFETY_REVIEW_RULES) {
    if (rule.pattern.test(normalized)) return { code: rule.code };
  }
  for (const rule of LOCAL_REVIEW_RULES) {
    if (rule.pattern.test(normalized)) return { code: rule.code };
  }
  return null;
}
