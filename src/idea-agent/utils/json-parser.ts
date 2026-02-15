/**
 * Robust JSON parser for LLM outputs.
 * Handles: BOM, markdown fences, trailing text, trailing commas, control characters.
 */
export function tryParseJson(content: string): unknown {
  // Step 1: direct parse
  try {
    return JSON.parse(content);
  } catch { /* fall through */ }

  // Step 2: strip BOM + trim
  const cleaned = content.replace(/^\uFEFF/, "").trim();
  if (cleaned !== content) {
    try {
      return JSON.parse(cleaned);
    } catch { /* fall through */ }
  }

  // Step 3: markdown fence extraction
  const fenceMatch = cleaned.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch { /* fall through */ }
  }

  // Step 4: brace-depth tracking
  const extracted = extractFirstJsonObject(cleaned);
  if (extracted) {
    try {
      return JSON.parse(extracted);
    } catch { /* fall through */ }

    // Step 5: fix trailing commas
    const fixed = extracted
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]");
    if (fixed !== extracted) {
      try {
        return JSON.parse(fixed);
      } catch { /* fall through */ }
    }

    // Step 6: escape control characters inside JSON strings
    const sanitized = escapeControlCharsInStrings(
      fixed !== extracted ? fixed : extracted,
    );
    if (sanitized) {
      try {
        return JSON.parse(sanitized);
      } catch { /* fall through */ }
    }
  }

  return undefined;
}

/**
 * Scan JSON text; when inside a "..." string, replace literal control chars
 * (0x00-0x1F) with their escape sequences.
 */
function escapeControlCharsInStrings(text: string): string | undefined {
  let result = "";
  let inStr = false;
  let esc = false;
  let changed = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (esc) { esc = false; result += ch; continue; }
    if (ch === "\\") { esc = true; result += ch; continue; }
    if (ch === '"') { inStr = !inStr; result += ch; continue; }
    if (inStr && code >= 0x00 && code <= 0x1f) {
      changed = true;
      if (code === 0x0a) { result += "\\n"; }
      else if (code === 0x0d) { result += "\\r"; }
      else if (code === 0x09) { result += "\\t"; }
      else { result += "\\u" + code.toString(16).padStart(4, "0"); }
      continue;
    }
    result += ch;
  }
  return changed ? result : undefined;
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}
