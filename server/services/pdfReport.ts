/**
 * Markdown → PDF report renderer.
 *
 * Uses `pdfkit` (pure JS, no native deps) + `marked` to walk a markdown
 * document and produce a McKinsey/Goldman-style report PDF: navy + gold
 * colour scheme, page header/footer, automatic page breaks, headings,
 * paragraphs, bullet lists, code blocks, and a cover page with company
 * name + report date.
 *
 * The design is intentionally split into a `ReportTheme` object so the
 * branding (colours, fonts, logo, header text) can be swapped per-template
 * later without touching the renderer logic. The `tools.py` reference
 * implementation in the agent template is the visual model for this:
 * dark navy (#1a365d) headings, gold (#d4af37) accents, monospaced data
 * tables, polished cover.
 */
import PDFDocument from "pdfkit";
import { marked, type Tokens } from "marked";

export interface ReportTheme {
  colors: {
    navy: string;
    gold: string;
    text: string;
    muted: string;
    bg: string;
  };
  fonts: {
    body: string;
    bold: string;
    italic: string;
    mono: string;
  };
  margins: { top: number; bottom: number; left: number; right: number };
  header?: string; // small text in top header bar
  footerLeft?: string;
}

export const DEFAULT_THEME: ReportTheme = {
  colors: {
    navy: "#1a365d",
    gold: "#d4af37",
    text: "#1f2937",
    muted: "#6b7280",
    bg: "#ffffff",
  },
  fonts: {
    body: "Helvetica",
    bold: "Helvetica-Bold",
    italic: "Helvetica-Oblique",
    mono: "Courier",
  },
  margins: { top: 72, bottom: 60, left: 60, right: 60 },
  header: "Bionic AI Solutions  ·  CONFIDENTIAL",
};

export interface ReportInput {
  title: string;
  subtitle?: string;
  markdown: string;
  preparedFor?: string;
  theme?: ReportTheme;
}

/**
 * Render a markdown report to a PDF buffer.
 *
 * The renderer is streaming-buffered: pdfkit emits to an in-memory chunks
 * array which we concat at the end. Suitable for ~10-50 page reports
 * (anything bigger should stream to a Writable instead).
 */
export async function renderReportPdf(input: ReportInput): Promise<Buffer> {
  const theme = input.theme || DEFAULT_THEME;
  const doc = new PDFDocument({
    autoFirstPage: false,
    margins: theme.margins,
    bufferPages: true,
    info: {
      Title: input.title,
      Subject: input.subtitle || "Investment due diligence report",
      Producer: "Bionic Crew Templates",
    },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done: Promise<Buffer> = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // ── Cover page ────────────────────────────────────────────────
  doc.addPage();
  drawCoverPage(doc, theme, input);

  // ── Body page(s) ──────────────────────────────────────────────
  doc.addPage();
  drawPageChrome(doc, theme);

  const tokens = marked.lexer(input.markdown);
  for (const tok of tokens) {
    renderToken(doc, theme, tok);
  }

  // ── Page numbers (must be after content; uses bufferPages) ────
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    drawFooter(doc, theme, i + 1, range.count);
  }

  doc.end();
  return done;
}

function drawCoverPage(
  doc: PDFKit.PDFDocument,
  theme: ReportTheme,
  input: ReportInput,
) {
  const w = doc.page.width;
  const h = doc.page.height;

  // Navy banner top
  doc.rect(0, 0, w, 180).fill(theme.colors.navy);
  // Gold accent strip
  doc.rect(0, 180, w, 6).fill(theme.colors.gold);

  // Branding
  doc
    .fillColor("#ffffff")
    .font(theme.fonts.bold)
    .fontSize(11)
    .text("BIONIC AI SOLUTIONS", theme.margins.left, 60, {
      characterSpacing: 2,
    });
  doc
    .fillColor(theme.colors.gold)
    .fontSize(9)
    .text("INVESTMENT DUE DILIGENCE", theme.margins.left, 78, {
      characterSpacing: 2,
    });

  // Report title — centred lower on the page
  doc
    .fillColor(theme.colors.navy)
    .font(theme.fonts.bold)
    .fontSize(34)
    .text(input.title, theme.margins.left, h * 0.42, {
      width: w - theme.margins.left - theme.margins.right,
      align: "left",
    });

  if (input.subtitle) {
    doc
      .fillColor(theme.colors.muted)
      .font(theme.fonts.italic)
      .fontSize(14)
      .text(input.subtitle, theme.margins.left, doc.y + 8, {
        width: w - theme.margins.left - theme.margins.right,
        align: "left",
      });
  }

  // Date + prepared-for block bottom-left
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  doc
    .fillColor(theme.colors.muted)
    .font(theme.fonts.body)
    .fontSize(10)
    .text(`PREPARED ${dateStr.toUpperCase()}`, theme.margins.left, h - 130, {
      characterSpacing: 1.5,
    });
  if (input.preparedFor) {
    doc
      .fillColor(theme.colors.text)
      .font(theme.fonts.bold)
      .fontSize(12)
      .text(`For: ${input.preparedFor}`, theme.margins.left, h - 110);
  }

  // Footer banner
  doc.rect(0, h - 40, w, 40).fill(theme.colors.navy);
  doc
    .fillColor(theme.colors.gold)
    .fontSize(8)
    .text("CONFIDENTIAL · FOR DISCUSSION PURPOSES ONLY", 0, h - 26, {
      width: w,
      align: "center",
      characterSpacing: 1.5,
    });

  // Reset cursor for next page
  doc.fillColor(theme.colors.text).font(theme.fonts.body);
}

function drawPageChrome(doc: PDFKit.PDFDocument, theme: ReportTheme) {
  const w = doc.page.width;
  // Top header bar
  doc.rect(0, 0, w, 28).fill(theme.colors.navy);
  doc.rect(0, 28, w, 2).fill(theme.colors.gold);
  doc
    .fillColor("#ffffff")
    .font(theme.fonts.body)
    .fontSize(8)
    .text(theme.header || "", theme.margins.left, 11, {
      characterSpacing: 1.5,
    });
  // Reset content cursor below the header
  doc.x = theme.margins.left;
  doc.y = theme.margins.top;
  doc.fillColor(theme.colors.text).font(theme.fonts.body).fontSize(11);
}

function drawFooter(
  doc: PDFKit.PDFDocument,
  theme: ReportTheme,
  pageNum: number,
  totalPages: number,
) {
  if (pageNum === 1) return; // skip footer on cover
  const w = doc.page.width;
  const h = doc.page.height;
  const y = h - 35;
  doc.save();
  doc
    .fillColor(theme.colors.muted)
    .font(theme.fonts.body)
    .fontSize(8)
    .text(theme.footerLeft || "Bionic AI Solutions", theme.margins.left, y);
  doc.text(
    `Page ${pageNum - 1} of ${totalPages - 1}`,
    theme.margins.left,
    y,
    {
      width: w - theme.margins.left - theme.margins.right,
      align: "right",
    },
  );
  doc.restore();
}

// ── Token renderers ─────────────────────────────────────────────

function ensureSpace(doc: PDFKit.PDFDocument, theme: ReportTheme, needed: number) {
  if (doc.y + needed > doc.page.height - theme.margins.bottom) {
    doc.addPage();
    drawPageChrome(doc, theme);
  }
}

function renderToken(
  doc: PDFKit.PDFDocument,
  theme: ReportTheme,
  tok: Tokens.Generic,
) {
  switch (tok.type) {
    case "heading":
      renderHeading(doc, theme, tok as Tokens.Heading);
      break;
    case "paragraph":
      renderParagraph(doc, theme, tok as Tokens.Paragraph);
      break;
    case "list":
      renderList(doc, theme, tok as Tokens.List);
      break;
    case "code":
      renderCode(doc, theme, tok as Tokens.Code);
      break;
    case "blockquote":
      renderBlockquote(doc, theme, tok as Tokens.Blockquote);
      break;
    case "hr":
      renderHr(doc, theme);
      break;
    case "table":
      renderTable(doc, theme, tok as Tokens.Table);
      break;
    case "space":
      doc.moveDown(0.4);
      break;
    default:
      // Fall back to plain text for unknown blocks
      if ("text" in tok && typeof (tok as any).text === "string") {
        renderParagraph(doc, theme, { type: "paragraph", raw: "", text: (tok as any).text, tokens: [] } as any);
      }
  }
}

function renderHeading(
  doc: PDFKit.PDFDocument,
  theme: ReportTheme,
  tok: Tokens.Heading,
) {
  const sizes = [22, 18, 14, 12, 11, 10];
  const size = sizes[tok.depth - 1] || 11;
  ensureSpace(doc, theme, size + 18);
  doc.moveDown(tok.depth === 1 ? 0.8 : 0.6);

  if (tok.depth === 1) {
    // h1 — gold underline rule
    const startY = doc.y;
    doc
      .fillColor(theme.colors.navy)
      .font(theme.fonts.bold)
      .fontSize(size)
      .text(stripInline(tok.text), { paragraphGap: 4 });
    doc
      .moveTo(theme.margins.left, doc.y + 2)
      .lineTo(theme.margins.left + 60, doc.y + 2)
      .lineWidth(2)
      .strokeColor(theme.colors.gold)
      .stroke();
    doc.moveDown(0.6);
    void startY;
  } else if (tok.depth === 2) {
    doc
      .fillColor(theme.colors.navy)
      .font(theme.fonts.bold)
      .fontSize(size)
      .text(stripInline(tok.text), { paragraphGap: 2 });
    doc.moveDown(0.3);
  } else {
    doc
      .fillColor(theme.colors.text)
      .font(theme.fonts.bold)
      .fontSize(size)
      .text(stripInline(tok.text), { paragraphGap: 2 });
    doc.moveDown(0.2);
  }
  // Reset for body
  doc.fillColor(theme.colors.text).font(theme.fonts.body).fontSize(11);
}

function renderParagraph(
  doc: PDFKit.PDFDocument,
  theme: ReportTheme,
  tok: Tokens.Paragraph,
) {
  ensureSpace(doc, theme, 30);
  doc
    .fillColor(theme.colors.text)
    .font(theme.fonts.body)
    .fontSize(11)
    .text(stripInline(tok.text), {
      align: "left",
      paragraphGap: 6,
      lineGap: 2,
    });
}

function renderList(
  doc: PDFKit.PDFDocument,
  theme: ReportTheme,
  tok: Tokens.List,
) {
  ensureSpace(doc, theme, 20);
  for (let i = 0; i < tok.items.length; i++) {
    const item = tok.items[i];
    const bullet = tok.ordered ? `${(tok.start || 1) + i}.` : "•";
    ensureSpace(doc, theme, 16);
    const startX = theme.margins.left;
    doc
      .fillColor(theme.colors.gold)
      .font(theme.fonts.bold)
      .fontSize(11)
      .text(bullet, startX, doc.y, { continued: false, width: 18 });
    const bulletY = doc.y - 14;
    doc
      .fillColor(theme.colors.text)
      .font(theme.fonts.body)
      .fontSize(11)
      .text(stripInline(item.text), startX + 18, bulletY, {
        width: doc.page.width - theme.margins.left - theme.margins.right - 18,
        lineGap: 2,
        paragraphGap: 2,
      });
  }
  doc.moveDown(0.4);
}

function renderCode(
  doc: PDFKit.PDFDocument,
  theme: ReportTheme,
  tok: Tokens.Code,
) {
  ensureSpace(doc, theme, 60);
  const x = theme.margins.left;
  const w = doc.page.width - theme.margins.left - theme.margins.right;
  // Shaded background
  const startY = doc.y + 4;
  doc
    .font(theme.fonts.mono)
    .fontSize(9)
    .fillColor(theme.colors.text);
  // Estimate height by line count (~12pt per line)
  const lines = tok.text.split(/\r?\n/);
  const blockHeight = lines.length * 12 + 16;
  ensureSpace(doc, theme, blockHeight + 8);
  doc.rect(x, startY, w, blockHeight).fill("#f3f4f6");
  doc
    .fillColor("#111827")
    .font(theme.fonts.mono)
    .fontSize(9)
    .text(tok.text, x + 8, startY + 8, { width: w - 16, lineGap: 2 });
  doc.moveDown(0.6);
  doc.fillColor(theme.colors.text).font(theme.fonts.body).fontSize(11);
}

function renderBlockquote(
  doc: PDFKit.PDFDocument,
  theme: ReportTheme,
  tok: Tokens.Blockquote,
) {
  ensureSpace(doc, theme, 30);
  const x = theme.margins.left + 10;
  const w = doc.page.width - theme.margins.left - theme.margins.right - 10;
  const startY = doc.y;
  doc
    .fillColor(theme.colors.muted)
    .font(theme.fonts.italic)
    .fontSize(11)
    .text(stripInline(tok.text || ""), x, doc.y, { width: w, lineGap: 2 });
  // Gold left rule
  doc
    .moveTo(theme.margins.left, startY)
    .lineTo(theme.margins.left, doc.y - 2)
    .lineWidth(2)
    .strokeColor(theme.colors.gold)
    .stroke();
  doc.moveDown(0.4);
  doc.fillColor(theme.colors.text).font(theme.fonts.body);
}

function renderHr(doc: PDFKit.PDFDocument, theme: ReportTheme) {
  ensureSpace(doc, theme, 14);
  const y = doc.y + 4;
  doc
    .moveTo(theme.margins.left, y)
    .lineTo(doc.page.width - theme.margins.right, y)
    .lineWidth(0.5)
    .strokeColor(theme.colors.muted)
    .stroke();
  doc.moveDown(0.6);
}

function renderTable(
  doc: PDFKit.PDFDocument,
  theme: ReportTheme,
  tok: Tokens.Table,
) {
  const cols = tok.header.length;
  const usableWidth = doc.page.width - theme.margins.left - theme.margins.right;
  const colWidth = usableWidth / cols;
  const rowHeight = 22;

  ensureSpace(doc, theme, rowHeight * (tok.rows.length + 1) + 10);

  // Header row
  let y = doc.y;
  doc.rect(theme.margins.left, y, usableWidth, rowHeight).fill(theme.colors.navy);
  doc.fillColor("#ffffff").font(theme.fonts.bold).fontSize(10);
  tok.header.forEach((cell: any, i: number) => {
    doc.text(stripInline(cell.text || ""), theme.margins.left + i * colWidth + 6, y + 7, {
      width: colWidth - 12,
      ellipsis: true,
    });
  });
  y += rowHeight;

  // Body rows
  doc.font(theme.fonts.body).fillColor(theme.colors.text).fontSize(10);
  tok.rows.forEach((row: any[], rowIdx: number) => {
    const bg = rowIdx % 2 === 0 ? "#f9fafb" : "#ffffff";
    doc.rect(theme.margins.left, y, usableWidth, rowHeight).fill(bg);
    row.forEach((cell: any, i: number) => {
      doc
        .fillColor(theme.colors.text)
        .text(stripInline(cell.text || ""), theme.margins.left + i * colWidth + 6, y + 7, {
          width: colWidth - 12,
          ellipsis: true,
        });
    });
    y += rowHeight;
  });

  doc.y = y + 6;
  doc.fillColor(theme.colors.text).font(theme.fonts.body).fontSize(11);
}

/** Strip simple inline markdown markers (`**`, `*`, `` ` ``) for renderers
 *  that don't yet handle styled runs. Keeps the visible text clean. */
function stripInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+?)`/g, "$1")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)");
}
