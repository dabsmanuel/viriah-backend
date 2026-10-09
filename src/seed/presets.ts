import { asPlatform } from '../core/context';
import { Preset, PlatformSetting, TemplateVersion } from '../models';
import { RESERVED_SLUGS } from '../core/host';

/**
 * Platform presets: Nigerian class levels, common subject lists per level, grading scales, assessment structures,
 * report layouts, behaviour traits, fee item names and a comment bank. A new school starts from these and can edit
 * its own copy (PLT-08). The super admin manages them in the console.
 */

export type GroupKey = 'nursery' | 'primary' | 'junior_secondary' | 'senior_secondary';

export const GROUPS: Array<{ key: GroupKey; name: string; order: number; layout: 'scores' | 'ratings'; showPositions: boolean }> = [
  { key: 'nursery', name: 'Nursery', order: 1, layout: 'ratings', showPositions: false },
  { key: 'primary', name: 'Primary', order: 2, layout: 'scores', showPositions: true },
  { key: 'junior_secondary', name: 'Junior Secondary', order: 3, layout: 'scores', showPositions: true },
  { key: 'senior_secondary', name: 'Senior Secondary', order: 4, layout: 'scores', showPositions: true }
];

interface LevelPreset {
  key: string;
  name: string;
  order: number;
  group: GroupKey;
  nextKey?: string;
  isFinal?: boolean;
  studentLogin: boolean;
}

/** Creche, Nursery 1 to 3, Primary 1 to 6, JSS 1 to 3, SSS 1 to 3. Suggested default: student login from Primary 4. */
export const LEVELS: LevelPreset[] = [
  { key: 'creche', name: 'Creche', order: 1, group: 'nursery', nextKey: 'nursery_1', studentLogin: false },
  { key: 'nursery_1', name: 'Nursery 1', order: 2, group: 'nursery', nextKey: 'nursery_2', studentLogin: false },
  { key: 'nursery_2', name: 'Nursery 2', order: 3, group: 'nursery', nextKey: 'nursery_3', studentLogin: false },
  { key: 'nursery_3', name: 'Nursery 3', order: 4, group: 'nursery', nextKey: 'primary_1', studentLogin: false },
  ...[1, 2, 3, 4, 5, 6].map((n): LevelPreset => ({ key: `primary_${n}`, name: `Primary ${n}`, order: 4 + n, group: 'primary', nextKey: n === 6 ? 'jss_1' : `primary_${n + 1}`, studentLogin: n >= 4 })),
  ...[1, 2, 3].map((n): LevelPreset => ({ key: `jss_${n}`, name: `JSS ${n}`, order: 10 + n, group: 'junior_secondary', nextKey: n === 3 ? 'sss_1' : `jss_${n + 1}`, studentLogin: true })),
  ...[1, 2, 3].map((n): LevelPreset => ({ key: `sss_${n}`, name: `SSS ${n}`, order: 13 + n, group: 'senior_secondary', nextKey: n === 3 ? undefined : `sss_${n + 1}`, isFinal: n === 3, studentLogin: true }))
];

interface SubjectPreset {
  name: string;
  shortName: string;
  groups: Array<{ group: GroupKey; compulsory: boolean; department?: 'science' | 'arts' | 'commercial' }>;
}

const P = (compulsory = true) => ({ group: 'primary' as GroupKey, compulsory });
const J = (compulsory = true) => ({ group: 'junior_secondary' as GroupKey, compulsory });
const S = (compulsory: boolean, department?: 'science' | 'arts' | 'commercial') => ({ group: 'senior_secondary' as GroupKey, compulsory, department });

export const SUBJECTS: SubjectPreset[] = [
  { name: 'English Language', shortName: 'ENG', groups: [P(), J(), S(true)] },
  { name: 'Mathematics', shortName: 'MTH', groups: [P(), J(), S(true)] },
  { name: 'Basic Science and Technology', shortName: 'BST', groups: [P()] },
  { name: 'Basic Science', shortName: 'BSC', groups: [J()] },
  { name: 'Basic Technology', shortName: 'BTC', groups: [J()] },
  { name: 'Social Studies', shortName: 'SOS', groups: [P(), J()] },
  { name: 'Civic Education', shortName: 'CVE', groups: [P(), J(), S(true)] },
  { name: 'Christian Religious Studies', shortName: 'CRS', groups: [P(false), J(false), S(false, 'arts')] },
  { name: 'Islamic Religious Studies', shortName: 'IRS', groups: [P(false), J(false), S(false, 'arts')] },
  { name: 'Agricultural Science', shortName: 'AGR', groups: [P(), J(), S(false, 'science')] },
  { name: 'Home Economics', shortName: 'HEC', groups: [P(), J()] },
  { name: 'Computer Studies', shortName: 'ICT', groups: [P(), J(), S(true)] },
  { name: 'Physical and Health Education', shortName: 'PHE', groups: [P(), J()] },
  { name: 'Cultural and Creative Arts', shortName: 'CCA', groups: [P(), J()] },
  { name: 'Business Studies', shortName: 'BUS', groups: [J()] },
  { name: 'French', shortName: 'FRN', groups: [J(false), S(false, 'arts')] },
  { name: 'Yoruba', shortName: 'YOR', groups: [P(false), J(false), S(false, 'arts')] },
  { name: 'Igbo', shortName: 'IGB', groups: [P(false), J(false), S(false, 'arts')] },
  { name: 'Hausa', shortName: 'HAU', groups: [P(false), J(false), S(false, 'arts')] },
  { name: 'Verbal Reasoning', shortName: 'VRS', groups: [P()] },
  { name: 'Quantitative Reasoning', shortName: 'QRS', groups: [P()] },
  { name: 'Entrepreneurship', shortName: 'ENT', groups: [S(true)] },
  { name: 'Physics', shortName: 'PHY', groups: [S(false, 'science')] },
  { name: 'Chemistry', shortName: 'CHM', groups: [S(false, 'science')] },
  { name: 'Biology', shortName: 'BIO', groups: [S(false, 'science')] },
  { name: 'Further Mathematics', shortName: 'FMT', groups: [S(false, 'science')] },
  { name: 'Technical Drawing', shortName: 'TDR', groups: [S(false, 'science')] },
  { name: 'Literature in English', shortName: 'LIT', groups: [S(false, 'arts')] },
  { name: 'Government', shortName: 'GOV', groups: [S(false, 'arts')] },
  { name: 'History', shortName: 'HIS', groups: [S(false, 'arts')] },
  { name: 'Geography', shortName: 'GEO', groups: [S(false, 'arts')] },
  { name: 'Economics', shortName: 'ECO', groups: [S(false, 'commercial')] },
  { name: 'Financial Accounting', shortName: 'ACC', groups: [S(false, 'commercial')] },
  { name: 'Commerce', shortName: 'COM', groups: [S(false, 'commercial')] },
  { name: 'Marketing', shortName: 'MKT', groups: [S(false, 'commercial')] },
  { name: 'Office Practice', shortName: 'OFP', groups: [S(false, 'commercial')] }
];

export const GRADING_SCALES = [
  {
    name: 'A to F (Primary and JSS)',
    groups: ['primary', 'junior_secondary', 'nursery'] as GroupKey[],
    passMark: 40,
    bands: [
      { min: 70, max: 100, grade: 'A', remark: 'Excellent' },
      { min: 60, max: 69, grade: 'B', remark: 'Very good' },
      { min: 50, max: 59, grade: 'C', remark: 'Good' },
      { min: 45, max: 49, grade: 'D', remark: 'Fair' },
      { min: 40, max: 44, grade: 'E', remark: 'Pass' },
      { min: 0, max: 39, grade: 'F', remark: 'Fail' }
    ]
  },
  {
    name: 'A1 to F9 (Senior Secondary)',
    groups: ['senior_secondary'] as GroupKey[],
    passMark: 40,
    bands: [
      { min: 75, max: 100, grade: 'A1', remark: 'Excellent' },
      { min: 70, max: 74, grade: 'B2', remark: 'Very good' },
      { min: 65, max: 69, grade: 'B3', remark: 'Good' },
      { min: 60, max: 64, grade: 'C4', remark: 'Credit' },
      { min: 55, max: 59, grade: 'C5', remark: 'Credit' },
      { min: 50, max: 54, grade: 'C6', remark: 'Credit' },
      { min: 45, max: 49, grade: 'D7', remark: 'Pass' },
      { min: 40, max: 44, grade: 'E8', remark: 'Pass' },
      { min: 0, max: 39, grade: 'F9', remark: 'Fail' }
    ]
  }
];

export const ASSESSMENT_STRUCTURES = [
  {
    name: '1st CA 20, 2nd CA 20, Exam 60',
    groups: ['primary', 'junior_secondary', 'senior_secondary', 'nursery'] as GroupKey[],
    components: [
      { key: 'ca1', name: '1st CA', max: 20, order: 1 },
      { key: 'ca2', name: '2nd CA', max: 20, order: 2 },
      { key: 'exam', name: 'Exam', max: 60, order: 3 }
    ]
  },
  {
    name: 'CA 40, Exam 60',
    groups: [] as GroupKey[],
    components: [
      { key: 'ca', name: 'Continuous assessment', max: 40, order: 1 },
      { key: 'exam', name: 'Exam', max: 60, order: 2 }
    ]
  },
  {
    name: 'CA 30, Project 10, Exam 60',
    groups: [] as GroupKey[],
    components: [
      { key: 'ca', name: 'Continuous assessment', max: 30, order: 1 },
      { key: 'project', name: 'Project', max: 10, order: 2 },
      { key: 'exam', name: 'Exam', max: 60, order: 3 }
    ]
  }
];

const FIVE = [
  { value: 5, label: 'Excellent' },
  { value: 4, label: 'Very good' },
  { value: 3, label: 'Good' },
  { value: 2, label: 'Fair' },
  { value: 1, label: 'Poor' }
];

export const TRAITS = [
  ...['Punctuality', 'Neatness', 'Politeness', 'Honesty', 'Cooperation', 'Attentiveness', 'Perseverance', 'Self-control', 'Leadership'].map((name) => ({ name, category: 'behaviour', groups: ['primary', 'junior_secondary', 'senior_secondary'] as GroupKey[], scale: FIVE })),
  ...['Handwriting', 'Sports', 'Drawing and painting', 'Musical skills', 'Verbal fluency', 'Handling tools', 'Craft'].map((name) => ({ name, category: 'skill', groups: ['primary', 'junior_secondary', 'senior_secondary'] as GroupKey[], scale: FIVE })),
  ...['Language and literacy', 'Numbers and counting', 'Phonics', 'Social habits', 'Health habits', 'Creative arts', 'Knowledge of the world', 'Rhymes and songs'].map((name) => ({
    name,
    category: 'learning_area',
    groups: ['nursery'] as GroupKey[],
    scale: [
      { value: 4, label: 'Mastered' },
      { value: 3, label: 'Developing well' },
      { value: 2, label: 'Needs practice' },
      { value: 1, label: 'Needs support' }
    ]
  }))
];

export const FEE_ITEMS = [
  { name: 'Tuition', optional: false },
  { name: 'Examination', optional: false },
  { name: 'PTA levy', optional: false },
  { name: 'Development levy', optional: false },
  { name: 'Uniform', optional: true },
  { name: 'Books', optional: true },
  { name: 'School bus', optional: true },
  { name: 'Lunch', optional: true },
  { name: 'Boarding', optional: true },
  { name: 'Extra lessons', optional: true }
];

export const COMMENT_BANK = [
  { author: 'class_teacher', minAverage: 80, maxAverage: 100, text: 'An outstanding result. Keep up the excellent work.' },
  { author: 'class_teacher', minAverage: 80, maxAverage: 100, text: 'A brilliant term. This is a pupil to be proud of.' },
  { author: 'class_teacher', minAverage: 70, maxAverage: 79.99, text: 'A very good result. Aim a little higher next term.' },
  { author: 'class_teacher', minAverage: 70, maxAverage: 79.99, text: 'Very good work. Steady effort will take you further.' },
  { author: 'class_teacher', minAverage: 60, maxAverage: 69.99, text: 'A good result. There is room to do better.' },
  { author: 'class_teacher', minAverage: 50, maxAverage: 59.99, text: 'A fair result. More reading and practice will help.' },
  { author: 'class_teacher', minAverage: 40, maxAverage: 49.99, text: 'A weak result. Extra effort is needed in the coming term.' },
  { author: 'class_teacher', minAverage: 0, maxAverage: 39.99, text: 'This result is poor. Please work closely with the teachers and at home.' },
  { author: 'principal', minAverage: 70, maxAverage: 100, text: 'Excellent. The school is proud of this performance.' },
  { author: 'principal', minAverage: 60, maxAverage: 69.99, text: 'A good performance. Keep working hard.' },
  { author: 'principal', minAverage: 50, maxAverage: 59.99, text: 'A fair performance. More effort will bring better results.' },
  { author: 'principal', minAverage: 0, maxAverage: 49.99, text: 'Needs serious improvement. The school will support you.' }
];

/** Idempotent: safe to run on every deploy. */
export async function seedPlatformPresets() {
  await asPlatform(async () => {
    const upsert = async (kind: string, name: string, data: Record<string, unknown>, order = 0) => {
      await Preset.updateOne({ kind, name }, { $setOnInsert: { kind, name, data, order, active: true } }, { upsert: true });
    };
    for (const g of GROUPS) await upsert('report_layouts', g.name, { group: g.key, layout: g.layout, showPositions: g.showPositions, order: g.order }, g.order);
    for (const l of LEVELS) await upsert('class_levels', l.name, { ...l }, l.order);
    SUBJECTS.forEach((s, i) => void i);
    let i = 0;
    for (const s of SUBJECTS) await upsert('subjects', s.name, { ...s }, i++);
    i = 0;
    for (const g of GRADING_SCALES) await upsert('grading_scales', g.name, { ...g }, i++);
    i = 0;
    for (const a of ASSESSMENT_STRUCTURES) await upsert('assessment_structures', a.name, { ...a }, i++);
    i = 0;
    for (const t of TRAITS) await upsert('behaviour_traits', t.name, { ...t }, i++);
    i = 0;
    for (const f of FEE_ITEMS) await upsert('fee_items', f.name, { ...f }, i++);
    i = 0;
    for (const c of COMMENT_BANK) await upsert('comment_bank', `${c.author}:${c.minAverage}-${c.maxAverage}:${c.text.slice(0, 20)}`, { ...c }, i++);

    await TemplateVersion.updateOne({ version: 1 }, { $setOnInsert: { version: 1, notes: 'First master template', releasedAt: new Date(), isCurrent: true } }, { upsert: true });
    await PlatformSetting.updateOne(
      { key: 'platform' },
      {
        $setOnInsert: {
          key: 'platform',
          reservedSlugs: RESERVED_SLUGS,
          legalTexts: {
            terms: 'Terms of use for schools, parents and students. Replace this text with the reviewed terms before launch.',
            privacy: 'Privacy notice. This platform holds personal data about children on behalf of schools. Replace this text with the reviewed notice before launch.',
            dpa: 'Data processing agreement between the platform and each school. Replace this text with the reviewed agreement before launch.',
            consent: 'I consent to the school and the platform holding my child’s personal data for admission and academic records, as described in the privacy notice.',
            refundPolicy: 'Refund and payment dispute policy. Replace this text before schools turn on online payment.',
            contentRules: 'Acceptable content rules for school websites. Replace this text before launch.'
          }
        }
      },
      { upsert: true }
    );
  });
}
