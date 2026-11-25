export type ReportedOutcome = "complete" | "partial" | "blocked" | "failed" | "changes_required";

const normalize = (value: string): ReportedOutcome | undefined => {
  switch (value.trim().toUpperCase().replace(/[ -]+/g, "_")) {
    case "COMPLETE": case "PASS": case "PASSED": return "complete";
    case "PARTIAL": return "partial";
    case "BLOCKED": return "blocked";
    case "FAIL": case "FAILED": return "failed";
    case "CHANGES_REQUIRED": return "changes_required";
  }
};

// Plain prose needs an explicit field or a standalone outcome at the beginning.
const outcome = "CHANGES[ _-]+REQUIRED|COMPLETE|PASS(?:ED)?|PARTIAL|BLOCKED|FAIL(?:ED)?";
const prefix = String.raw`^[ \t]*(?:#{1,6}[ \t]+)?[ \t]*\**[ \t]*`;
const field = String.raw`(STATUS|VERDICT)[ \t*]*[:=—–-][ \t*_\x60]*`;
const patterns = (flattened: boolean) => {
  const nextField = flattened ? String.raw`|(?=[ \t]+(?:#{1,6}[ \t]+|\*\*[A-Z][A-Z ]*:\*\*))` : "";
  const end = String.raw`[ \t]*[*_\x60]*(?:[ \t]*(?:$|[:;—–])|[ \t]+-[ \t]+${nextField})`;
  return {
    explicit: new RegExp(`${prefix}${field}(${outcome}|APPROVED|NEEDS +CHANGES)${end}`, "i"),
    standalone: new RegExp(`${prefix}(${outcome})${end}`, "i"),
  };
};
const native = patterns(false);
const history = patterns(true);
// History v1 loses line boundaries. Only surviving Markdown markers, including
// the review agent's **Verdict:** field, can identify fields inside an excerpt.
const historyField = / (?=#{1,6} +\**(?:STATUS|VERDICT)\b|\*\*VERDICT:\*\*)/gi;

function* nativeLines(summary: string): Iterable<string> {
  let fence: string | undefined;
  for (const line of summary.split(/\r\n?|\n/)) {
    const marker = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = undefined;
    } else if (marker) fence = marker[1];
    else if (line.trim()) yield line;
  }
}

function* historySections(summary: string): Iterable<string> {
  let fence: string | undefined;
  let start = 0;
  // A flattened fence no longer has a line ending. Skip ambiguous fenced spans
  // rather than turning their Markdown examples into results.
  for (const marker of summary.matchAll(/(?:^| )(`{3,}|~{3,})/g)) {
    const end = marker.index + marker[0].length;
    if (!fence) {
      yield summary.slice(start, marker.index);
      fence = marker[1];
    } else if (marker[1].startsWith(fence) && (end === summary.length || summary[end] === " ")) {
      start = end;
      fence = undefined;
    }
  }
  if (!fence) yield summary.slice(start);
}

function* historyLines(summary: string): Iterable<string> {
  let first = true;
  for (const section of historySections(summary)) {
    if (!section.trim()) continue;
    if (first) {
      first = false;
      yield section;
    }
    for (const marker of section.matchAll(historyField)) yield section.slice(marker.index);
  }
}

export function reportedOutcome(structured: string | undefined, summary: string | undefined, flattened = false): ReportedOutcome | undefined {
  const authoritative = structured ? normalize(structured) : undefined;
  if (authoritative || !summary) return authoritative;
  const { explicit, standalone } = flattened ? history : native;
  let first = true;
  let status: ReportedOutcome | undefined;
  for (const line of flattened ? historyLines(summary) : nativeLines(summary)) {
    if (first) {
      first = false;
      const match = standalone.exec(line);
      if (match) return normalize(match[1]);
    }
    const match = explicit.exec(line);
    if (!match) continue;
    const value = normalize(match[2]);
    if (match[1].toUpperCase() === "VERDICT") {
      // Reviewer verdicts are outcome proposals, not plan or delivery status.
      return value ?? (match[2].toUpperCase() === "APPROVED" ? "complete" : "changes_required");
    }
    status ??= value;
  }
  return status;
}
