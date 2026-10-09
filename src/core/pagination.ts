import type { FilterQuery, Model, PopulateOptions } from 'mongoose';
import ExcelJS from 'exceljs';
import { saveGenerated, files } from '../integrations/storage';
import { getCtx } from './context';
import { ok, type Meta, type Reply } from './http';
import { safeCell } from './sanitize';

export interface Paging {
  page: number;
  limit: number;
  skip: number;
  sort: Record<string, 1 | -1>;
}

/** ?page=1&limit=25&sort=-createdAt. Sorting only on allowed fields. */
export function paging(query: Record<string, unknown>, allowedSort: string[], defaultSort = '-createdAt'): Paging {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
  const sort: Record<string, 1 | -1> = {};
  const raw = typeof query.sort === 'string' && query.sort ? query.sort : defaultSort;
  for (const part of raw.split(',')) {
    const desc = part.startsWith('-');
    const field = desc ? part.slice(1) : part;
    if (allowedSort.includes(field)) sort[field] = desc ? -1 : 1;
  }
  if (!Object.keys(sort).length) {
    const d = defaultSort.startsWith('-') ? defaultSort.slice(1) : defaultSort;
    sort[d] = defaultSort.startsWith('-') ? -1 : 1;
  }
  sort._id = sort._id ?? 1;
  return { page, limit, skip: (page - 1) * limit, sort };
}

/** Escape user text for use inside a regular expression. */
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const searchRegex = (q: string) => new RegExp(escapeRegex(q.trim()), 'i');

export interface PageArgs<T> {
  model: Model<any>;
  filter: FilterQuery<any>;
  query: Record<string, unknown>;
  allowedSort: string[];
  defaultSort?: string;
  select?: string;
  populate?: PopulateOptions | PopulateOptions[];
  map?: (doc: any) => T | Promise<T>;
  /** columns for ?format=xlsx|csv */
  columns?: Array<{ header: string; value: (row: T) => unknown }>;
  exportName?: string;
}

/** Paged list with meta. If ?format=xlsx or csv is given, returns a file link instead (API 1.6). */
export async function pagedList<T = any>(a: PageArgs<T>): Promise<Reply> {
  const p = paging(a.query, a.allowedSort, a.defaultSort);
  const format = a.query.format as 'xlsx' | 'csv' | undefined;
  const find = a.model.find(a.filter).sort(p.sort).lean();
  if (a.select) find.select(a.select);
  if (a.populate) find.populate(a.populate as any);

  if (format && a.columns) {
    const rows = (await find.limit(5000)) as any[];
    const mapped = a.map ? await Promise.all(rows.map(a.map)) : (rows as unknown as T[]);
    const link = await exportRows(a.exportName ?? 'export', a.columns, mapped, format);
    return ok(link);
  }

  const [rows, total] = await Promise.all([find.skip(p.skip).limit(p.limit), a.model.countDocuments(a.filter)]);
  const data = a.map ? await Promise.all((rows as any[]).map(a.map)) : (rows as unknown as T[]);
  const meta: Meta = { page: p.page, limit: p.limit, total };
  return ok(data, meta);
}

/** Build an Excel or CSV file from rows, store it, and return a short-lived link. Money columns are numbers. */
export async function exportRows<T>(name: string, columns: Array<{ header: string; value: (row: T) => unknown }>, rows: T[], format: 'xlsx' | 'csv') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name.slice(0, 31));
  ws.addRow(columns.map((c) => c.header));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(columns.map((c) => safeCell(c.value(r))));
  ws.columns.forEach((c) => (c.width = 18));
  const schoolId = getCtx()?.schoolId ?? 'platform';
  let buf: Buffer;
  let mime: string;
  if (format === 'csv') {
    buf = Buffer.from(await wb.csv.writeBuffer());
    mime = 'text/csv';
  } else {
    buf = Buffer.from(await wb.xlsx.writeBuffer());
    mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  const ref = await saveGenerated(schoolId, buf, mime, format);
  return { url: files.link(ref, 600), fileRef: ref, name: `${name}.${format}`, rows: rows.length };
}
