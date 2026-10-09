import { formatDate } from '../lib/dates';
import { header, loadImage, newDoc, NGN, qrPng, table, watermark, type Brand } from './pdf';

/**
 * Report card as a branded PDF (RES-10): school logo and colours, student details and photograph, subject table, attendance,
 * ratings, comments, signature and stamp, next term start date and next term fees. A verification code and QR let a third
 * party check it on the school's website. Nursery levels use ratings and teacher remarks in place of scores and positions.
 */

export interface CardSubject {
  name: string;
  components: Record<string, number | 'ABS' | null | undefined>;
  exempt?: boolean;
  total: number | null;
  grade: string | null;
  remark: string | null;
  position?: number | null;
  classAverage?: number | null;
  highest?: number | null;
  lowest?: number | null;
}

export interface ReportCardData {
  student: { name: string; admissionNumber: string; gender?: string; dob?: string; photo?: Buffer };
  className: string;
  sessionName: string;
  termNumber: number;
  layout: 'scores' | 'ratings';
  showPositions: boolean;
  components: Array<{ key: string; name: string; max: number }>;
  subjects: CardSubject[];
  summary?: { subjectsCount: number; total: number; average: number; position: number | null; classSize: number };
  attendance?: { opened: number; present: number; absent: number };
  ratings: Array<{ name: string; label?: string; value?: number; remark?: string; category?: string }>;
  teacherComment?: string;
  principalComment?: string;
  nextTermBegins?: string;
  nextTermFeesKobo?: number;
  promotion?: string;
  verificationCode: string;
  verifyUrl: string;
  revisedAt?: Date;
  signature?: Buffer;
  stamp?: Buffer;
  passMark?: number;
}

const f2 = (n: number | null | undefined) => (n === null || n === undefined ? '-' : (Math.round(n * 100) / 100).toFixed(n % 1 === 0 ? 0 : n * 10 % 1 === 0 ? 1 : 2));

export async function drawReportCard(doc: PDFKit.PDFDocument, brand: Brand, logo: Buffer | undefined, d: ReportCardData) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const tokens = header(doc, brand, logo, 'REPORT CARD', `Term ${d.termNumber}, ${d.sessionName}`);

  // ---- student block with photograph
  const top = doc.y;
  if (d.student.photo) {
    try {
      doc.image(d.student.photo, left + width - 70, top, { fit: [64, 76] });
    } catch {
      /* unreadable photo: carry on */
    }
  }
  const kv = (k: string, v: string, x: number, y: number) => {
    doc.font('Helvetica').fontSize(7.5).fillColor('#666666').text(k.toUpperCase(), x, y, { width: 150 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111').text(v || '-', x, doc.y, { width: 175 });
  };
  kv('Name', d.student.name, left, top);
  kv('Admission number', d.student.admissionNumber, left + 190, top);
  const y2 = Math.max(doc.y, top + 30) + 4;
  kv('Class', d.className, left, y2);
  kv('Gender', d.student.gender ?? '-', left + 190, y2);
  doc.y = Math.max(doc.y, top + 80) + 6;

  if (d.layout === 'scores') {
    // ---- subject table
    const fixed = { subject: 112, total: 36, grade: 32, pos: d.showPositions ? 30 : 0, avg: 36, high: 32, low: 32, remark: 0 };
    const comps = d.components;
    const used = fixed.subject + fixed.total + fixed.grade + fixed.pos + fixed.avg + fixed.high + fixed.low;
    const compW = Math.max(30, Math.floor((width - used - 80) / Math.max(1, comps.length)));
    const remarkW = width - used - compW * comps.length;
    const cols = [
      { header: 'Subject', width: fixed.subject },
      ...comps.map((c) => ({ header: `${c.name} (${c.max})`, width: compW, align: 'center' as const })),
      { header: 'Total', width: fixed.total, align: 'center' as const },
      { header: 'Grade', width: fixed.grade, align: 'center' as const },
      ...(d.showPositions ? [{ header: 'Pos', width: fixed.pos, align: 'center' as const }] : []),
      { header: 'Avg', width: fixed.avg, align: 'center' as const },
      { header: 'High', width: fixed.high, align: 'center' as const },
      { header: 'Low', width: fixed.low, align: 'center' as const },
      { header: 'Remark', width: remarkW }
    ];
    const rows = d.subjects.map((s) => [
      s.name,
      ...comps.map((c) => (s.exempt ? '' : String(s.components[c.key] ?? '-'))),
      s.exempt ? 'EXEMPT' : f2(s.total),
      s.grade ?? '',
      ...(d.showPositions ? [s.position ? String(s.position) : '-'] : []),
      f2(s.classAverage),
      f2(s.highest),
      f2(s.lowest),
      s.remark ?? ''
    ]);
    table(doc, cols, rows, { headFill: tokens.primary, headColor: tokens.primaryContrast, fontSize: 8, rowHeight: 16 });

    // ---- summary strip
    doc.y += 6;
    if (d.summary) {
      const s = d.summary;
      const items: Array<[string, string]> = [
        ['Subjects', String(s.subjectsCount)],
        ['Total', f2(s.total)],
        ['Average', s.average.toFixed(2)],
        ...(d.showPositions && s.position ? ([['Position', `${s.position} of ${s.classSize}`]] as Array<[string, string]>) : []),
        ...(d.attendance ? ([['Days opened', String(d.attendance.opened)], ['Present', String(d.attendance.present)], ['Absent', String(d.attendance.absent)]] as Array<[string, string]>) : [])
      ];
      const w = width / items.length;
      const y = doc.y;
      doc.rect(left, y, width, 34).lineWidth(0.5).strokeColor('#cccccc').stroke();
      items.forEach(([k, v], i) => {
        doc.font('Helvetica').fontSize(7).fillColor('#666666').text(k.toUpperCase(), left + i * w + 6, y + 5, { width: w - 8 });
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111').text(v, left + i * w + 6, y + 16, { width: w - 8 });
      });
      doc.y = y + 42;
    }
  } else if (d.attendance) {
    doc.font('Helvetica').fontSize(9).fillColor('#444444').text(`Days opened ${d.attendance.opened}   Present ${d.attendance.present}   Absent ${d.attendance.absent}`, left, doc.y);
    doc.y += 8;
  }

  // ---- ratings (behaviour and skills, or nursery learning areas)
  const rated = d.ratings.filter((r) => r.label !== undefined || r.remark);
  if (rated.length) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111111').text(d.layout === 'ratings' ? 'Learning areas' : 'Behaviour and skills', left, doc.y);
    doc.y += 2;
    const cols = d.layout === 'ratings' ? [{ header: 'Learning area', width: 170 }, { header: 'Rating', width: 110 }, { header: 'Teacher’s remark', width: width - 280 }] : [{ header: 'Trait', width: 170 }, { header: 'Rating', width: width - 170 }];
    table(doc, cols, rated.map((r) => (d.layout === 'ratings' ? [r.name, r.label ?? '', r.remark ?? ''] : [r.name, r.label ?? ''])), { headFill: '#eeeeee', fontSize: 8, rowHeight: 15 });
    doc.y += 6;
  }

  // ---- comments
  if (doc.y > doc.page.height - 230) doc.addPage();
  const block = (label: string, text?: string) => {
    if (!text) return;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111111').text(label, left, doc.y);
    doc.font('Helvetica').fontSize(9).fillColor('#333333').text(text, left, doc.y + 1, { width });
    doc.y += 6;
  };
  block('Class teacher’s comment', d.teacherComment);
  block('Principal’s comment', d.principalComment);
  if (d.promotion) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(tokens.primaryText).text(`Promotion: ${d.promotion}`, left, doc.y + 2);
    doc.y += 8;
  }
  doc.font('Helvetica').fontSize(8.5).fillColor('#333333');
  const next = [d.nextTermBegins ? `Next term begins: ${formatDate(d.nextTermBegins)}` : '', d.nextTermFeesKobo ? `Next term fees: ${NGN(d.nextTermFeesKobo)}` : ''].filter(Boolean).join('     ');
  if (next) doc.text(next, left, doc.y + 2);

  // ---- signature, stamp, verification
  const by = Math.min(doc.y + 14, doc.page.height - doc.page.margins.bottom - 96);
  if (d.signature) {
    try {
      doc.image(d.signature, left, by, { fit: [110, 40] });
    } catch {
      /* skip */
    }
  }
  doc.moveTo(left, by + 44).lineTo(left + 130, by + 44).lineWidth(0.5).strokeColor('#999999').stroke();
  doc.font('Helvetica').fontSize(7.5).fillColor('#666666').text('Principal’s signature', left, by + 47);
  if (d.stamp) {
    try {
      doc.image(d.stamp, left + 160, by - 6, { fit: [70, 70] });
    } catch {
      /* skip */
    }
  }
  const qr = await qrPng(d.verifyUrl);
  doc.image(qr, left + width - 84, by - 6, { width: 80 });
  doc.font('Helvetica').fontSize(7).fillColor('#555555').text(`Verify: ${d.verificationCode}`, left + width - 200, by + 76, { width: 196, align: 'right' });
  if (d.revisedAt) doc.text(`Revised copy, ${formatDate(d.revisedAt)}`, left, by + 62, { width: 250 });
  doc.fillColor('#111111');
  if (d.revisedAt) {
    // a revised card is marked as such
    doc.save();
    doc.fillColor('#b45309').opacity(0.9).font('Helvetica-Bold').fontSize(9).text('REVISED', doc.page.width - doc.page.margins.right - 70, doc.page.margins.top - 12, { width: 70, align: 'right' });
    doc.opacity(1).restore();
  }
  void watermark;
}

export async function reportCardPdf(brand: Brand, d: ReportCardData): Promise<Buffer> {
  const { doc, done } = newDoc({ info: { Title: `Report card, ${d.student.name}` } });
  const logo = await loadImage(brand.logoRef);
  d.signature ??= await loadImage(brand.signatureRef);
  d.stamp ??= await loadImage(brand.stampRef);
  await drawReportCard(doc, brand, logo, d);
  doc.end();
  return done;
}

/** All the report cards of a class in one PDF so the school can print a whole class in one go. */
export async function reportCardsPdf(brand: Brand, cards: ReportCardData[]): Promise<Buffer> {
  const { doc, done } = newDoc({ info: { Title: 'Report cards' } });
  const logo = await loadImage(brand.logoRef);
  const signature = await loadImage(brand.signatureRef);
  const stamp = await loadImage(brand.stampRef);
  for (let i = 0; i < cards.length; i++) {
    if (i > 0) doc.addPage();
    cards[i].signature ??= signature;
    cards[i].stamp ??= stamp;
    await drawReportCard(doc, brand, logo, cards[i]);
  }
  if (!cards.length) doc.text('No report cards.');
  doc.end();
  return done;
}

// ------------------------------------------------------------------ broadsheet

export interface BroadsheetData {
  className: string;
  termLabel: string;
  subjects: string[];
  rows: Array<{ name: string; admissionNumber: string; cells: Array<{ total: number | null; grade: string | null } | null>; subjectsCount: number; total: number | null; average: number | null; position: number | null }>;
  showPositions: boolean;
}

export async function broadsheetPdf(brand: Brand, d: BroadsheetData): Promise<Buffer> {
  const { doc, done } = newDoc({ landscape: true, margin: 28, info: { Title: `Broadsheet ${d.className}` } });
  const logo = await loadImage(brand.logoRef);
  const tokens = header(doc, brand, logo, 'BROADSHEET', `${d.className}, ${d.termLabel}`);
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const subjW = Math.max(30, Math.min(46, Math.floor((width - 150 - 130) / Math.max(1, d.subjects.length))));
  const cols = [
    { header: 'Student', width: 110 },
    ...d.subjects.map((s) => ({ header: s.slice(0, 9), width: subjW, align: 'center' as const })),
    { header: 'Total', width: 40, align: 'center' as const },
    { header: 'Avg', width: 38, align: 'center' as const },
    ...(d.showPositions ? [{ header: 'Pos', width: 30, align: 'center' as const }] : [])
  ];
  table(
    doc,
    cols,
    d.rows.map((r) => [r.name, ...r.cells.map((c) => (c && c.total !== null ? `${c.total} ${c.grade ?? ''}`.trim() : '')), r.total === null ? '' : String(r.total), r.average === null ? '' : r.average.toFixed(2), ...(d.showPositions ? [r.position ? String(r.position) : ''] : [])]),
    { headFill: tokens.primary, headColor: tokens.primaryContrast, fontSize: 7, rowHeight: 14 }
  );
  doc.end();
  return done;
}
