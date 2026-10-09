import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { validation } from '../core/errors';
import { files } from '../integrations/storage';

/** Reading uploaded spreadsheets (XLSX or CSV). At most 5,000 rows (Document 3, section 11). */

export const MAX_ROWS = 5000;

/** "Admission number" and "admission_number" and "ADMISSION NUMBER" are the same column. */
export const norm = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

const cellText = (v: any): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('text' in v) return String(v.text ?? '').trim();
    if ('result' in v) return String(v.result ?? '').trim();
    if ('richText' in v) return (v.richText as any[]).map((r) => r.text).join('').trim();
  }
  return String(v).trim();
};

export interface Table {
  headers: string[]; // normalised
  rows: Array<{ n: number; cells: Record<string, string> }>; // n is the spreadsheet row number
}

export async function readTable(fileRef: string): Promise<Table> {
  const buf = await files.getBuffer(fileRef);
  const wb = new ExcelJS.Workbook();
  try {
    if (/\.csv$/i.test(fileRef)) await wb.csv.read(Readable.from(buf));
    else await wb.xlsx.load(buf as any);
  } catch {
    throw validation('That file could not be read. Use the template, saved as Excel or CSV.', { fileRef: 'Unreadable file.' });
  }
  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 1) throw validation('The file is empty.', { fileRef: 'Empty file.' });
  const headers = (ws.getRow(1).values as any[]).slice(1).map((h) => norm(cellText(h)));
  const rows: Table['rows'] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const vals = (row.values as any[]).slice(1);
    const cells: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h) cells[h] = cellText(vals[i]);
    });
    if (Object.values(cells).some((v) => v !== '')) rows.push({ n, cells });
  });
  if (rows.length > MAX_ROWS) throw validation(`The file has ${rows.length} rows. The limit is ${MAX_ROWS}. Split it into smaller files.`, { fileRef: `More than ${MAX_ROWS} rows.` });
  return { headers, rows };
}

/** Build a template workbook with a header row, drop-down lists, and optional example rows. */
export async function buildTemplate(opts: { name: string; columns: Array<{ header: string; width?: number; list?: string[]; note?: string }>; rows?: string[][]; notes?: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(opts.name.slice(0, 31));
  ws.addRow(opts.columns.map((c) => c.header));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  opts.columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width ?? Math.max(14, c.header.length + 4);
  });
  for (const r of opts.rows ?? []) ws.addRow(r);
  // Drop-downs come from a hidden "Lists" sheet so long lists work in every spreadsheet program.
  const lists = opts.columns.filter((c) => c.list?.length);
  if (lists.length) {
    const ls = wb.addWorksheet('Lists', { state: 'hidden' });
    lists.forEach((c, li) => {
      c.list!.forEach((v, ri) => (ls.getCell(ri + 1, li + 1).value = v));
      const col = opts.columns.indexOf(c) + 1;
      const letter = ls.getColumn(li + 1).letter;
      for (let r = 2; r <= 501; r++) {
        ws.getCell(r, col).dataValidation = { type: 'list', allowBlank: true, formulae: [`Lists!$${letter}$1:$${letter}$${c.list!.length}`], showErrorMessage: true, errorTitle: 'Choose from the list', error: `Choose a value from the list for ${c.header}.` };
      }
    });
  }
  if (opts.notes) {
    const ns = wb.addWorksheet('Read me');
    opts.notes.split('\n').forEach((line, i) => (ns.getCell(i + 1, 1).value = line));
    ns.getColumn(1).width = 100;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
