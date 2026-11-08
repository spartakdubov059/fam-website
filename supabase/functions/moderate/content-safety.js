const EMAIL_RE = /[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}/iu;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()]+/iu;
const SOCIAL_DOMAIN_RE = /(?:^|[^\p{L}\d])(?:t\.me|vk\.com|telegram\.me|wa\.me|discord\.gg|instagram\.com|youtube\.com)(?:\/[^\s]*)?/iu;
const BARE_DOMAIN_RE = /(?:^|[^\p{L}\d])(?:[\p{L}\d](?:[\p{L}\d-]{0,61}[\p{L}\d])?\.)+(?:ru|рф|com|net|org|io|me|gg|info|site|online)(?:\/[^\s]*)?(?=$|[^\p{L}\d])/iu;
const HANDLE_RE = /(?<![\p{L}\p{N}])@[a-z0-9_]{3,32}\b/iu;
const ADDRESS_RE = /(?:^|[^\p{L}\p{N}])(?:ул(?:ица)?\.?|проспект|пр-т|переулок|пер\.?|дом|д\.?|квартира|кв\.?|подъезд|адрес)\s*[\p{L}\d№.,/-]{0,48}\d/iu;
const PHONE_RE = /(?<!\d)\+?\d(?:[ \t().-]*\d){9,14}(?!\d)/gu;
const POSTCODE_RE = /(?:почтов(?:ый|ого)\s+индекс|индекс)\s*[:№-]?\s*\d{6}\b/iu;

const LOCAL_REVIEW_RULES = [
  { code: "controlled_substances", pattern: /(?:^|[^\p{L}\p{N}])(?:наркот[\p{L}]*|мефедрон[\p{L}]*|спайс[\p{L}]*|закладк[\p{L}]*|героин[\p{L}]*|амфетамин[\p{L}]*|экстази[\p{L}]*|мдма|кокаин[\p{L}]*|снюс[\p{L}]*|насвай[\p{L}]*)(?=$|[^\p{L}\p{N}])/iu },
  { code: "nicotine_or_alcohol", pattern: /(?:^|[^\p{L}\p{N}])(?:сигарет[\p{L}]*|вейп[\p{L}]*|никотин[\p{L}]*|табак[\p{L}]*|кальян[\p{L}]*|алкогол[\p{L}]*|водк[\p{L}]*|пив[\p{L}]*|энергетик[\p{L}]*)(?=$|[^\p{L}\p{N}])/iu },
  { code: "restricted_or_adult_content", pattern: /(?:^|[^\p{L}\p{N}])(?:порно[\p{L}]*|интим[\p{L}]*|казино|ставк[\p{L}]*|оруж[\p{L}]*|пистолет[\p{L}]*|взрывчат[\p{L}]*|насили[\p{L}]*|травл[\p{L}]*|буллинг)(?=$|[^\p{L}\p{N}])/iu },
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
    ADDRESS_RE.test(withoutDates) ||
    POSTCODE_RE.test(withoutDates)
  ) return true;

  PHONE_RE.lastIndex = 0;
  return PHONE_RE.test(withoutDates);
}

export function findLocalPolicyFlag(value) {
  const normalized = String(value ?? "").normalize("NFKC");
  for (const rule of LOCAL_REVIEW_RULES) {
    if (rule.pattern.test(normalized)) return { code: rule.code };
  }
  return null;
}
