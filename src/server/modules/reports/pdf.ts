import { createHash } from "node:crypto";

/**
 * A deterministic PDF writer.
 *
 * Two renders of the same document must be byte-identical, which rules out the
 * usual generators: they stamp a creation date and a random file identifier.
 * Here every byte is a function of the document content — the file identifier
 * is a hash of that content, and there is no date in the output at all. The
 * report snapshot carries the timestamps that matter, and they are drawn on the
 * page as text.
 *
 * Only the 14 standard PDF fonts are used, so no font file is embedded and no
 * subsetting decision can vary between runs.
 */

// Helvetica advance widths (units per 1000) for the printable ASCII range,
// starting at space (32). Accurate wrapping needs real widths; the table is
// short enough to carry rather than approximate.
const helveticaWidths = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const helveticaBoldWidths = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

export type FontName = "Helvetica" | "Helvetica-Bold";

function widthsFor(font: FontName): number[] {
  return font === "Helvetica-Bold" ? helveticaBoldWidths : helveticaWidths;
}

/** Width of one line in points at the given size. */
export function textWidth(text: string, font: FontName, size: number): number {
  const widths = widthsFor(font);
  let total = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 32;
    total += code >= 32 && code <= 126 ? widths[code - 32] : widths[0];
  }
  return (total * size) / 1000;
}

export function wrapText(text: string, font: FontName, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim().length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;
      if (textWidth(candidate, font, size) <= maxWidth || current.length === 0) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current.length > 0) lines.push(current);
  }
  return lines;
}

/**
 * PDF text strings are Latin-1. Characters outside it (an ʻokina, an em dash)
 * are mapped to a supported equivalent rather than emitted raw, which would
 * corrupt the file.
 */
const substitutions: Record<string, string> = {
  "‘": "'", "’": "'", "ʻ": "'", "ʼ": "'",
  "“": '"', "”": '"',
  "–": "-", "—": "-", "…": "...",
  " ": " ", "→": "->",
};

export function toLatin1(text: string): string {
  let output = "";
  for (const character of text) {
    const replacement = substitutions[character];
    if (replacement !== undefined) {
      output += replacement;
      continue;
    }
    const code = character.codePointAt(0) ?? 32;
    output += code <= 0xff ? character : "?";
  }
  return output;
}

function escapePdfText(text: string): string {
  return toLatin1(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export interface PdfBlock {
  text: string;
  font: FontName;
  size: number;
  /** Extra space above the block, in points. */
  spaceBefore?: number;
}

export interface PdfDocumentInput {
  title: string;
  blocks: PdfBlock[];
}

const pageWidth = 612;
const pageHeight = 792;
const margin = 54;
const contentWidth = pageWidth - margin * 2;
const lineGap = 1.35;

interface RenderedPage {
  operations: string[];
}

function buildPages(input: PdfDocumentInput): RenderedPage[] {
  const pages: RenderedPage[] = [];
  let operations: string[] = [];
  let cursor = pageHeight - margin;

  const startPage = () => {
    if (operations.length > 0) pages.push({ operations });
    operations = [];
    cursor = pageHeight - margin;
  };

  for (const block of input.blocks) {
    const lines = wrapText(block.text, block.font, block.size, contentWidth);
    const lineHeight = block.size * lineGap;
    cursor -= block.spaceBefore ?? 0;

    for (const line of lines) {
      if (cursor - lineHeight < margin) startPage();
      cursor -= lineHeight;
      if (line.length === 0) continue;
      operations.push(
        `BT /${block.font === "Helvetica-Bold" ? "F2" : "F1"} ${block.size} Tf ` +
          `1 0 0 1 ${margin.toFixed(2)} ${cursor.toFixed(2)} Tm ` +
          `(${escapePdfText(line)}) Tj ET`,
      );
    }
  }
  if (operations.length > 0) pages.push({ operations });
  return pages.length > 0 ? pages : [{ operations: [] }];
}

/**
 * Serializes the document. The only variable input is the content, so the same
 * document always produces the same bytes.
 */
export function renderPdf(input: PdfDocumentInput): Buffer {
  const pages = buildPages(input);
  const objects: string[] = [];

  // 1 catalog, 2 pages, 3 F1, 4 F2, then per page: page object + content stream.
  const pageObjectIds = pages.map((_page, index) => 5 + index * 2);
  const contentObjectIds = pages.map((_page, index) => 6 + index * 2);

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectIds
      .map((id) => `${id} 0 R`)
      .join(" ")}] >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  pages.forEach((page, index) => {
    const content = page.operations.join("\n");
    objects[pageObjectIds[index]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectIds[index]} 0 R >>`;
    objects[contentObjectIds[index]] =
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  });

  // The file identifier is derived from the content, not from a clock or a
  // random source, so it is stable across renders.
  const fingerprint = createHash("sha256")
    .update(input.title)
    .update(objects.filter(Boolean).join(""))
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    if (!objects[id]) continue;
    offsets[id] = Buffer.byteLength(body, "latin1");
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(body, "latin1");
  const highestId = objects.length;
  let xref = `xref\n0 ${highestId}\n0000000000 65535 f \n`;
  for (let id = 1; id < highestId; id += 1) {
    xref += offsets[id] === undefined
      ? "0000000000 65535 f \n"
      : `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }

  const trailer =
    `trailer\n<< /Size ${highestId} /Root 1 0 R /ID [<${fingerprint}> <${fingerprint}>] >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, "latin1");
}
