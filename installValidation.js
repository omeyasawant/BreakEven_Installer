const BANNED_NAME_WORDS = [
  "scam",
  "scom",
  "omeya",
  "omi",
  "ome",
  "omay",
  "omya",
  "omy",
  "oma",
];

const NORMALIZATION_CHAR_MAP = {
  0: "o",
  1: "i",
  3: "e",
  4: "a",
  5: "s",
  6: "g",
  7: "t",
  8: "b",
  9: "g",
  "@": "a",
  $: "s",
  "!": "i",
  "+": "t",
};

const SOLANA_PUBLIC_KEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

function getDefaultInstallPathForPlatform(platform) {
  if (platform === "win32") return "C:\\Program Files\\BreakEvenClient";
  if (platform === "darwin") return "/Applications/BreakEvenClient";
  if (platform === "linux") return "/opt/BreakEvenClient";
  return "";
}

function normalizeNameForModeration(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split("")
    .map((char) => NORMALIZATION_CHAR_MAP[char] || char)
    .join("")
    .replace(/[^a-z]/g, "")
    .replace(/(.)\1+/g, "$1");
}

function buildPhoneticKeys(value) {
  const normalized = normalizeNameForModeration(value);
  if (!normalized) return [];

  const phoneticBase = normalized
    .replace(/^kn/, "n")
    .replace(/^gn/, "n")
    .replace(/^wr/, "r")
    .replace(/^wh/, "w")
    .replace(/tch/g, "ch")
    .replace(/dge/g, "j")
    .replace(/dgi/g, "j")
    .replace(/dgy/g, "j")
    .replace(/ph/g, "f")
    .replace(/sch/g, "sk")
    .replace(/ch/g, "x")
    .replace(/sh/g, "x")
    .replace(/th/g, "0")
    .replace(/ck/g, "k")
    .replace(/qu/g, "k")
    .replace(/q/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/y/g, "i")
    .replace(/w/g, "v");

  const primary =
    (phoneticBase[0] || "") + phoneticBase.slice(1).replace(/[aeiou]/g, "");
  const secondary = phoneticBase.replace(/[aeiou]/g, "");

  return Array.from(
    new Set(
      [primary, secondary]
        .map((key) => key.replace(/(.)\1+/g, "$1"))
        .filter(Boolean),
    ),
  );
}

function damerauLevenshteinDistance(source, target) {
  if (source === target) return 0;
  if (!source.length) return target.length;
  if (!target.length) return source.length;

  const matrix = Array.from({ length: source.length + 1 }, () =>
    new Array(target.length + 1).fill(0),
  );

  for (let row = 0; row <= source.length; row += 1) {
    matrix[row][0] = row;
  }
  for (let col = 0; col <= target.length; col += 1) {
    matrix[0][col] = col;
  }

  for (let row = 1; row <= source.length; row += 1) {
    for (let col = 1; col <= target.length; col += 1) {
      const cost = source[row - 1] === target[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost,
      );

      if (
        row > 1 &&
        col > 1 &&
        source[row - 1] === target[col - 2] &&
        source[row - 2] === target[col - 1]
      ) {
        matrix[row][col] = Math.min(
          matrix[row][col],
          matrix[row - 2][col - 2] + 1,
        );
      }
    }
  }

  return matrix[source.length][target.length];
}

function buildComparisonSegments(value, targetLength) {
  const segments = new Set([value]);
  const minLength = Math.max(1, targetLength - 2);
  const maxLength = Math.min(value.length, targetLength + 2);

  for (let length = minLength; length <= maxLength; length += 1) {
    for (let index = 0; index <= value.length - length; index += 1) {
      segments.add(value.slice(index, index + length));
    }
  }

  return Array.from(segments);
}

function getEditDistanceThreshold(targetLength) {
  if (targetLength <= 4) return 1;
  return 2;
}

const BANNED_NAME_RULES = BANNED_NAME_WORDS.map((word) => ({
  word,
  normalized: normalizeNameForModeration(word),
  phoneticKeys: buildPhoneticKeys(word),
}));

function validateRestrictedName(value) {
  const trimmedValue = String(value || "").trim();
  if (!trimmedValue) {
    return "Name is required.";
  }

  const normalized = normalizeNameForModeration(trimmedValue);
  if (!normalized) {
    return "Name must include at least one letter.";
  }

  for (const rule of BANNED_NAME_RULES) {
    if (
      normalized.includes(rule.normalized) ||
      (normalized.length >= 3 && rule.normalized.includes(normalized))
    ) {
      return "Name cannot contain or closely resemble restricted words.";
    }

    if (rule.normalized.length < 4) {
      continue;
    }

    const candidates = buildComparisonSegments(
      normalized,
      rule.normalized.length,
    );
    const candidatePhonetics = new Set(
      candidates.flatMap((candidate) => buildPhoneticKeys(candidate)),
    );
    const editDistanceThreshold = getEditDistanceThreshold(
      rule.normalized.length,
    );

    for (const candidate of candidates) {
      if (
        damerauLevenshteinDistance(candidate, rule.normalized) <=
        editDistanceThreshold
      ) {
        return "Name cannot contain or closely resemble restricted words.";
      }
    }

    if (rule.phoneticKeys.some((key) => candidatePhonetics.has(key))) {
      return "Name cannot contain or closely resemble restricted words.";
    }
  }

  return null;
}

function validateNameAndEmail(nameValue, emailValue) {
  const normalizedName = String(nameValue || "").trim();
  const normalizedEmail = String(emailValue || "").trim();

  let nameError = "";
  if (!normalizedName) {
    nameError = "Name is required.";
  } else if (normalizedName.length > 20) {
    nameError = "Name must be 20 characters or fewer.";
  } else if (!/^[a-zA-Z0-9\s]+$/.test(normalizedName)) {
    nameError = "Name must use letters, numbers, and spaces only.";
  } else {
    nameError = validateRestrictedName(normalizedName) || "";
  }

  let emailError = "";
  if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    emailError = "Invalid email format.";
  }

  return {
    valid: !nameError && !emailError,
    nameError,
    emailError,
    normalizedName,
    normalizedEmail,
  };
}

function validateBufferCores(value, defaultValue = 6) {
  if (value === undefined || value === null || value === "") {
    return { valid: true, value: defaultValue };
  }

  const numericValue = Number(value);
  if (
    !Number.isInteger(numericValue) ||
    numericValue < 0 ||
    numericValue > 100
  ) {
    return {
      valid: false,
      error: "buffer_cores must be an integer between 0 and 100.",
    };
  }

  return { valid: true, value: numericValue };
}

function validateSolanaWalletAddress(value, options = {}) {
  const { allowEmpty = true, optionName = "Wallet address" } = options;

  if (value === undefined || value === null) {
    return allowEmpty
      ? { valid: true, value: "" }
      : { valid: false, error: `${optionName} is required.` };
  }

  const normalizedValue = String(value).trim();
  if (!normalizedValue) {
    return allowEmpty
      ? { valid: true, value: "" }
      : { valid: false, error: `${optionName} is required.` };
  }

  if (!SOLANA_PUBLIC_KEY_RE.test(normalizedValue)) {
    return {
      valid: false,
      error: `${optionName} must be a valid Solana public address.`,
    };
  }

  return { valid: true, value: normalizedValue };
}

module.exports = {
  getDefaultInstallPathForPlatform,
  validateRestrictedName,
  validateNameAndEmail,
  validateBufferCores,
  validateSolanaWalletAddress,
};
