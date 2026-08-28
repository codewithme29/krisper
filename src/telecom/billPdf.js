import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PAGE_SIZE = [595.28, 841.89]; // A4 in points
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_SIZE[0] - MARGIN * 2;

// pdf-lib's built-in fonts use WinAnsi encoding, which does not include the
// ₹ glyph and will throw ("WinAnsi cannot encode...") if you try to draw it.
// "Rs." is dependency-free and always safe. If you want the literal ₹ symbol,
// embed a Unicode font (e.g. Noto Sans) via @pdf-lib/fontkit instead.
const money = (n) => `Rs. ${Number(n).toLocaleString("en-IN")}`;

/**
 * Builds a one-page (or more, if items overflow) PDF bill for a subscriber.
 * @param {object} acct - an entry from ACCOUNTS, as shaped in the router
 * @returns {Promise<Uint8Array>} PDF bytes
 */
export async function buildBillPdf(acct) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Bill - ${acct.accountId}`);
  doc.setAuthor("Telecom Subscriber Care");

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage(PAGE_SIZE);
  let y = PAGE_SIZE[1] - MARGIN;

  const ensureSpace = (needed) => {
    if (y - needed < MARGIN) {
      page = doc.addPage(PAGE_SIZE);
      y = PAGE_SIZE[1] - MARGIN;
    }
  };

  const text = (str, { x = MARGIN, size = 11, useFont = font, color = rgb(0.1, 0.1, 0.1) } = {}) => {
    page.drawText(str, { x, y, size, font: useFont, color });
  };

  // --- Header ---
  text("Bill Summary", { size: 20, useFont: bold });
  y -= 24;
  text(acct.plan, { size: 11, color: rgb(0.35, 0.35, 0.35) });
  y -= 24;

  // --- Account details ---
  for (const row of [
    `Name: ${acct.name}`,
    `Account ID: ${acct.accountId}`,
    `Phone: ${acct.phone}`,
    `Billing cycle: ${acct.billingCycle}`,
    `Due date: ${acct.dueDate}`,
  ]) {
    text(row);
    y -= 15;
  }
  y -= 10;

  // --- Anomaly callout (mirrors the plain-language explanation logic) ---
  const extra = acct.currentBill - acct.averageBill;
  ensureSpace(60);
  if (extra > 0) {
    const boxHeight = 42;
    page.drawRectangle({
      x: MARGIN, y: y - boxHeight + 12, width: CONTENT_WIDTH, height: boxHeight,
      color: rgb(0.95, 0.95, 1), borderColor: rgb(0.6, 0.6, 0.85), borderWidth: 1,
    });
    text(
      `Total due: ${money(acct.currentBill)}  (${money(extra)} more than your usual ${money(acct.averageBill)})`,
      { x: MARGIN + 10, size: 12, useFont: bold, color: rgb(0.15, 0.15, 0.4) }
    );
    y -= boxHeight + 14;
  } else {
    text(`Total due: ${money(acct.currentBill)}`, { size: 14, useFont: bold });
    y -= 30;
  }

  // --- Line items table ---
  ensureSpace(40);
  text("Charges", { size: 13, useFont: bold });
  y -= 22;

  const col = { label: MARGIN, category: MARGIN + 280, amount: MARGIN + 380 };
  text("Description", { x: col.label, size: 10, useFont: bold });
  text("Category", { x: col.category, size: 10, useFont: bold });
  text("Amount", { x: col.amount, size: 10, useFont: bold });
  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + CONTENT_WIDTH, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  y -= 16;

  for (const item of acct.lineItems) {
    ensureSpace(30);
    text(item.label, { x: col.label, size: 10 });
    text(item.category, { x: col.category, size: 10 });
    text(money(item.amount), { x: col.amount, size: 10 });
    y -= 13;
    if (item.note) {
      ensureSpace(15);
      text(item.note, { x: col.label + 10, size: 8.5, color: rgb(0.45, 0.45, 0.45) });
      y -= 13;
    }
    y -= 5;
  }

  ensureSpace(50);
  page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + CONTENT_WIDTH, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  y -= 20;
  text(`Total: ${money(acct.currentBill)}`, { size: 12, useFont: bold });
  y -= 30;

  // --- Footer ---
  ensureSpace(20);
  text(`Generated ${new Date().toISOString().slice(0, 10)} — for reference only, not a tax invoice.`, {
    size: 8.5, color: rgb(0.5, 0.5, 0.5),
  });

  return doc.save();
}