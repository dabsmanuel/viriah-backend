/** Phone numbers are stored in international format (+234...) and shown in local format. */

export function normalizePhone(input: string): string | null {
  if (typeof input !== 'string') return null;
  let s = input.replace(/[\s\-().]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+')) {
    return /^\+\d{8,15}$/.test(s) ? s : null;
  }
  if (/^234\d{10}$/.test(s)) return `+${s}`;
  if (/^0\d{10}$/.test(s)) return `+234${s.slice(1)}`;
  if (/^[789]\d{9}$/.test(s)) return `+234${s}`;
  return null;
}

export const isValidPhone = (s: string) => normalizePhone(s) !== null;

/** +2348031234567 -> 08031234567. Other countries are shown as stored. */
export function formatPhoneLocal(phone: string): string {
  return /^\+234\d{10}$/.test(phone) ? `0${phone.slice(4)}` : phone;
}

export const maskPhone = (phone: string) => (phone.length > 6 ? `${phone.slice(0, 4)}****${phone.slice(-3)}` : '****');
export const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, '$1***$2');
