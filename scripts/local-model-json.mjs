export function extractJsonObject(content) {
  if (typeof content !== "string") {
    throw new TypeError("Local model returned a non-text response.");
  }

  let source = content;
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  source = source.trim();

  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < source.length; index += 1) {
      const character = source[index];

      if (inString) {
        if (escaped) escaped = false;
        else if (character.charCodeAt(0) === 92) escaped = true;
        else if (character === '"') inString = false;
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = source.slice(start, index + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              return parsed;
            }
          } catch {
            // Ignore prose/code braces and continue searching for a valid JSON object.
          }
          break;
        }
      }
    }
  }

  throw new Error("Local model did not return a valid JSON object.");
}

export function assertRequiredFields(value, schema, label = "model response") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must be a JSON object.");
  }

  const required = Array.isArray(schema?.required) ? schema.required : [];
  const missing = required.filter((field) =>
    !Object.prototype.hasOwnProperty.call(value, field)
  );
  if (missing.length) {
    throw new Error(label + " is missing required fields: " + missing.join(", "));
  }

  return value;
}

export function parseJson(content) {
  return extractJsonObject(content);
}
