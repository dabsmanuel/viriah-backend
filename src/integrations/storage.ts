import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env';
import { AppError, validation } from '../core/errors';
import { hmac, randomToken, safeEqual, sha256 } from '../lib/crypto';

/**
 * Files (Document 3, section 11).
 *
 * Upload flow: the browser asks the API for signed upload parameters for a stated purpose. The API checks permission
 * and returns parameters fixed to that school's folder and that purpose's limits. The browser uploads straight to the
 * store and sends the returned file reference to the API, which confirms the file exists in the expected folder
 * before saving the reference. Private files are only reachable through short-lived links the API signs after a
 * permission check.
 *
 * Cloudinary is used when its keys are set. Otherwise files live on local disk and the API serves them itself.
 */

export type Purpose =
  | 'site_image' // logo, hero, gallery, staff photos on the website: public
  | 'brand_asset' // logo, favicon, stamp, signature: public
  | 'student_photo'
  | 'student_document'
  | 'admission_document'
  | 'task_file'
  | 'submission_file'
  | 'payment_proof'
  | 'import_file'
  | 'generated';

interface PurposeSpec {
  public: boolean;
  mimes: string[];
  maxBytes: number;
  maxFiles?: number;
}

const MB = 1024 * 1024;
const IMG = ['image/jpeg', 'image/png', 'image/webp'];
export const PURPOSES: Record<Purpose, PurposeSpec> = {
  site_image: { public: true, mimes: IMG, maxBytes: 5 * MB },
  brand_asset: { public: true, mimes: IMG, maxBytes: 5 * MB }, // SVG is not accepted, because it can carry scripts
  student_photo: { public: false, mimes: ['image/jpeg', 'image/png'], maxBytes: 2 * MB },
  student_document: { public: false, mimes: ['image/jpeg', 'image/png', 'application/pdf'], maxBytes: 5 * MB },
  admission_document: { public: false, mimes: ['image/jpeg', 'image/png', 'application/pdf'], maxBytes: 5 * MB },
  task_file: {
    public: false,
    mimes: ['image/jpeg', 'image/png', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    maxBytes: 10 * MB,
    maxFiles: 5
  },
  submission_file: {
    public: false,
    mimes: ['image/jpeg', 'image/png', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    maxBytes: 10 * MB,
    maxFiles: 5
  },
  payment_proof: { public: false, mimes: ['image/jpeg', 'image/png', 'application/pdf'], maxBytes: 5 * MB },
  import_file: {
    public: false,
    mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'application/vnd.ms-excel', 'application/octet-stream'],
    maxBytes: 5 * MB
  },
  generated: { public: false, mimes: ['application/pdf', 'application/zip', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'], maxBytes: 200 * MB }
};

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/octet-stream': 'bin'
};

export interface SignedUpload {
  fileRef: string;
  method: 'PUT' | 'POST';
  uploadUrl: string;
  fields?: Record<string, string>;
  maxBytes: number;
  allowedMimes: string[];
  expiresAt: string;
}

export interface FileStore {
  name: string;
  signUpload(args: { schoolId: string; purpose: Purpose; mime: string }): Promise<SignedUpload>;
  /** Confirm the file exists in the expected folder and within limits. */
  confirm(fileRef: string, schoolId: string, purpose: Purpose): Promise<{ bytes: number }>;
  putBuffer(fileRef: string, buf: Buffer, mime: string): Promise<void>;
  getBuffer(fileRef: string): Promise<Buffer>;
  /** Short-lived link for a private file, or the public URL for a public one. */
  link(fileRef: string, ttlSeconds?: number): string;
  remove(fileRef: string): Promise<void>;
}

const isPublicRef = (ref: string) => ref.includes('/pub/');

/** Refs look like "<schoolId>/<pub|pri>/<purpose>/<random>.<ext>". The school folder is the first segment. */
export function buildRef(schoolId: string, purpose: Purpose, mime: string): string {
  const ext = EXT[mime] ?? 'bin';
  return `${schoolId}/${PURPOSES[purpose].public ? 'pub' : 'pri'}/${purpose}/${randomToken(12)}.${ext}`;
}

export const refSchoolId = (ref: string) => ref.split('/')[0];
export const refPurpose = (ref: string) => ref.split('/')[2] as Purpose;

export function assertUploadAllowed(purpose: Purpose, mime: string, size?: number) {
  const spec = PURPOSES[purpose];
  if (!spec) throw validation('Unknown upload purpose.', { purpose: 'Choose a valid purpose.' });
  if (!spec.mimes.includes(mime)) throw validation('That file type is not accepted.', { mime: `Allowed types: ${spec.mimes.map((m) => EXT[m]).join(', ')}.` });
  if (size !== undefined && size > spec.maxBytes) throw validation(`The file is too large. The limit is ${Math.round(spec.maxBytes / MB)} MB.`, { size: `Limit ${Math.round(spec.maxBytes / MB)} MB.` });
}

// ---------------------------------------------------------------- local disk driver (development)

const ROOT = path.resolve(process.cwd(), 'storage');
const abs = (ref: string) => {
  const p = path.resolve(ROOT, ref);
  if (!p.startsWith(ROOT + path.sep)) throw new AppError('forbidden', 'Bad file reference.');
  return p;
};

export interface LocalToken {
  ref: string;
  mime: string;
  max: number;
  exp: number;
}
const signLocal = (t: LocalToken) => {
  const body = Buffer.from(JSON.stringify(t)).toString('base64url');
  return `${body}.${hmac(body, env.COOKIE_SECRET)}`;
};
export function verifyLocalToken(token: string): LocalToken {
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(body, env.COOKIE_SECRET))) throw new AppError('forbidden', 'This link is not valid.');
  const t = JSON.parse(Buffer.from(body, 'base64url').toString()) as LocalToken;
  if (t.exp < Date.now()) throw new AppError('forbidden', 'This link has expired.');
  return t;
}

const local: FileStore = {
  name: 'local',
  async signUpload({ schoolId, purpose, mime }) {
    assertUploadAllowed(purpose, mime);
    const fileRef = buildRef(schoolId, purpose, mime);
    const spec = PURPOSES[purpose];
    const exp = Date.now() + 15 * 60_000;
    const token = signLocal({ ref: fileRef, mime, max: spec.maxBytes, exp });
    return { fileRef, method: 'PUT', uploadUrl: `/api/v1/files/local-upload/${token}`, maxBytes: spec.maxBytes, allowedMimes: spec.mimes, expiresAt: new Date(exp).toISOString() };
  },
  async confirm(fileRef, schoolId, purpose) {
    if (refSchoolId(fileRef) !== schoolId || refPurpose(fileRef) !== purpose) throw validation('That file is not in the expected folder.', { fileRef: 'Upload the file again.' });
    try {
      const st = await fs.stat(abs(fileRef));
      if (st.size > PURPOSES[purpose].maxBytes) throw validation('The file is too large.');
      return { bytes: st.size };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw validation('The file was not found. Upload it again.', { fileRef: 'Upload the file again.' });
    }
  },
  async putBuffer(fileRef, buf) {
    const p = abs(fileRef);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, buf);
  },
  async getBuffer(fileRef) {
    return fs.readFile(abs(fileRef));
  },
  link(fileRef, ttl = 300) {
    const exp = Date.now() + ttl * 1000;
    return `/api/v1/files/local/${signLocal({ ref: fileRef, mime: '', max: 0, exp })}`;
  },
  async remove(fileRef) {
    await fs.rm(abs(fileRef), { force: true });
  }
};

export async function localSave(token: LocalToken, buf: Buffer) {
  if (buf.length > token.max) throw validation(`The file is too large. The limit is ${Math.round(token.max / MB)} MB.`);
  await local.putBuffer(token.ref, buf, token.mime);
}

// ---------------------------------------------------------------- Cloudinary driver

const cloudName = env.CLOUDINARY_CLOUD_NAME;
const sign = (params: Record<string, string | number>) => {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + env.CLOUDINARY_API_SECRET).digest('hex');
};

const cloudinary: FileStore = {
  name: 'cloudinary',
  async signUpload({ schoolId, purpose, mime }) {
    assertUploadAllowed(purpose, mime);
    const spec = PURPOSES[purpose];
    const fileRef = buildRef(schoolId, purpose, mime);
    const publicId = fileRef.replace(/\.[a-z0-9]+$/i, '');
    const timestamp = Math.floor(Date.now() / 1000);
    const type = spec.public ? 'upload' : 'authenticated';
    const params: Record<string, string | number> = { public_id: publicId, timestamp, type, allowed_formats: spec.mimes.map((m) => EXT[m]).join(',') };
    const resource = mime.startsWith('image/') ? 'image' : 'raw';
    return {
      fileRef,
      method: 'POST',
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/${resource}/upload`,
      fields: { ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), api_key: env.CLOUDINARY_API_KEY, signature: sign(params) },
      maxBytes: spec.maxBytes,
      allowedMimes: spec.mimes,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
    };
  },
  async confirm(fileRef, schoolId, purpose) {
    if (refSchoolId(fileRef) !== schoolId || refPurpose(fileRef) !== purpose) throw validation('That file is not in the expected folder.', { fileRef: 'Upload the file again.' });
    const publicId = fileRef.replace(/\.[a-z0-9]+$/i, '');
    const spec = PURPOSES[purpose];
    const resource = /\.(jpg|png|webp)$/i.test(fileRef) ? 'image' : 'raw';
    const type = spec.public ? 'upload' : 'authenticated';
    const auth = Buffer.from(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`).toString('base64');
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/resources/${resource}/${type}/${encodeURIComponent(publicId)}`, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) throw validation('The file was not found. Upload it again.', { fileRef: 'Upload the file again.' });
    const json = (await res.json()) as { bytes: number };
    if (json.bytes > spec.maxBytes) {
      await this.remove(fileRef);
      throw validation(`The file is too large. The limit is ${Math.round(spec.maxBytes / MB)} MB.`);
    }
    return { bytes: json.bytes };
  },
  async putBuffer(fileRef, buf, mime) {
    const publicId = fileRef.replace(/\.[a-z0-9]+$/i, '');
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { public_id: publicId, timestamp, type: 'authenticated' };
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, String(v));
    form.append('api_key', env.CLOUDINARY_API_KEY);
    form.append('signature', sign(params));
    form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), path.basename(fileRef));
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${mime.startsWith('image/') ? 'image' : 'raw'}/upload`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Cloudinary upload failed: ${res.status}`);
  },
  async getBuffer(fileRef) {
    const res = await fetch(this.link(fileRef, 120));
    if (!res.ok) throw new Error(`Cloudinary fetch failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
  link(fileRef, ttl = 300) {
    const publicId = fileRef.replace(/\.[a-z0-9]+$/i, '');
    const resource = /\.(jpg|png|webp)$/i.test(fileRef) ? 'image' : 'raw';
    const ext = fileRef.split('.').pop();
    if (isPublicRef(fileRef)) {
      return `https://res.cloudinary.com/${cloudName}/${resource}/upload/f_auto,q_auto/${publicId}.${ext}`;
    }
    // Authenticated delivery with an expiring signed URL.
    const expires = Math.floor(Date.now() / 1000) + ttl;
    const toSign = `${publicId}.${ext}?exp=${expires}`;
    const sig = crypto.createHash('sha256').update(toSign + env.CLOUDINARY_API_SECRET).digest('base64url').slice(0, 32);
    return `https://res.cloudinary.com/${cloudName}/${resource}/authenticated/s--${sig}--/${publicId}.${ext}?exp=${expires}`;
  },
  async remove(fileRef) {
    const publicId = fileRef.replace(/\.[a-z0-9]+$/i, '');
    const timestamp = Math.floor(Date.now() / 1000);
    const type = isPublicRef(fileRef) ? 'upload' : 'authenticated';
    const params = { public_id: publicId, timestamp, type };
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, String(v));
    form.append('api_key', env.CLOUDINARY_API_KEY);
    form.append('signature', sign(params));
    await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${/\.(jpg|png|webp)$/i.test(fileRef) ? 'image' : 'raw'}/destroy`, { method: 'POST', body: form });
  }
};

let store: FileStore = env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY ? cloudinary : local;
export const setFileStore = (s: FileStore) => (store = s);
export const files = {
  get driver() {
    return store;
  },
  signUpload: (a: Parameters<FileStore['signUpload']>[0]) => store.signUpload(a),
  confirm: (ref: string, schoolId: string, purpose: Purpose) => store.confirm(ref, schoolId, purpose),
  putBuffer: (ref: string, buf: Buffer, mime: string) => store.putBuffer(ref, buf, mime),
  getBuffer: (ref: string) => store.getBuffer(ref),
  link: (ref: string, ttl?: number) => store.link(ref, ttl),
  remove: (ref: string) => store.remove(ref)
};

/** Public URL for images that are served publicly (logo, hero, gallery). Returns undefined for empty refs. */
export const publicUrl = (ref?: string | null) => (ref ? store.link(ref) : undefined);

/** Save generated output (PDFs, spreadsheets, archives) under the school's folder. Returns the file ref. */
export async function saveGenerated(schoolId: string, buf: Buffer, mime: string, ext?: string): Promise<string> {
  const ref = `${schoolId}/pri/generated/${randomToken(12)}.${ext ?? EXT[mime] ?? 'bin'}`;
  await store.putBuffer(ref, buf, mime);
  return ref;
}

export const fileFingerprint = (buf: Buffer) => sha256(buf.toString('base64'));
