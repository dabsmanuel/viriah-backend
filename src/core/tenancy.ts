import mongoose, { Schema, Types } from 'mongoose';
import { getCtx } from './context';

/**
 * Tenant isolation, layer 3 (Document 3, section 5).
 *
 * Every tenant model gets this plugin. It adds schoolId from the request context to every find, count,
 * update, delete and aggregate, and sets it on every create. If there is no school in the context the
 * operation throws. Platform-level code must wrap its work in asPlatform() or forSchool(id).
 */

export const tenantModelNames: string[] = [];
export const platformModelNames: string[] = [];

const oid = (id: string) => new Types.ObjectId(id);

type Scope = { skip: true } | { skip: false; schoolId: Types.ObjectId };

function scope(op: string): Scope {
  const ctx = getCtx();
  if (!ctx) throw new Error(`Tenant query (${op}) ran with no request context. Wrap it in forSchool(id) or asPlatform().`);
  if (ctx.platform) return { skip: true };
  if (!ctx.schoolId) throw new Error(`Tenant query (${op}) ran with no school in context.`);
  return { skip: false, schoolId: oid(ctx.schoolId) };
}

const QUERY_HOOKS = [
  'find',
  'findOne',
  'countDocuments',
  'distinct',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace'
] as const;

export function tenantPlugin(schemaIn: Schema<any>) {
  const schema = schemaIn as any;
  // No standalone index: every index on a tenant collection starts with schoolId, see tenantSchema().
  schema.add({ schoolId: { type: Schema.Types.ObjectId, required: true } });

  schema.pre(QUERY_HOOKS as unknown as string[], function (this: any) {
    const s = scope(this.op);
    if (s.skip) return;
    const filter = this.getFilter();
    this.setQuery({ $and: [filter, { schoolId: s.schoolId }] });
    // An upsert must also create the document inside the school.
    if (this.getOptions().upsert) {
      const update = this.getUpdate() ?? {};
      if (!Array.isArray(update)) {
        update.$setOnInsert = { ...(update.$setOnInsert ?? {}), schoolId: s.schoolId };
        this.setUpdate(update);
      }
    }
  });

  schema.pre('aggregate', function (this: any) {
    const s = scope('aggregate');
    if (s.skip) return;
    this.pipeline().unshift({ $match: { schoolId: s.schoolId } });
  });

  schema.pre('validate', function (this: any) {
    const ctx = getCtx();
    if (!ctx) throw new Error('Tenant document saved with no request context.');
    if (ctx.platform) {
      if (!this.schoolId) throw new Error('Platform code must set schoolId explicitly when creating tenant documents.');
      return;
    }
    if (!ctx.schoolId) throw new Error('Tenant document saved with no school in context.');
    if (this.isNew) {
      if (this.schoolId && String(this.schoolId) !== ctx.schoolId) throw new Error('Cross-school write refused.');
      this.schoolId = oid(ctx.schoolId);
    } else if (this.schoolId && String(this.schoolId) !== ctx.schoolId) {
      throw new Error('Cross-school write refused.');
    }
  });

  schema.pre('insertMany', function (next: any, docs: any) {
    try {
      const s = scope('insertMany');
      const arr = Array.isArray(docs) ? docs : [docs];
      for (const d of arr) {
        if (s.skip) {
          if (!d.schoolId) throw new Error('Platform code must set schoolId explicitly when creating tenant documents.');
        } else {
          if (d.schoolId && String(d.schoolId) !== String(s.schoolId)) throw new Error('Cross-school write refused.');
          d.schoolId = s.schoolId;
        }
      }
      next();
    } catch (e) {
      next(e as Error);
    }
  });

  // bulkWrite hook: scope every operation to the school.
  (schema as any).pre('bulkWrite', function (next: any, ops: any[]) {
    try {
      const s = scope('bulkWrite');
      if (!s.skip) {
        for (const op of ops) {
          const kind = Object.keys(op)[0];
          const body = op[kind];
          if (kind === 'insertOne') body.document.schoolId = s.schoolId;
          else if (body.filter) body.filter = { $and: [body.filter, { schoolId: s.schoolId }] };
          if (body.upsert && body.update && !Array.isArray(body.update)) {
            body.update.$setOnInsert = { ...(body.update.$setOnInsert ?? {}), schoolId: s.schoolId };
          }
        }
      }
      next();
    } catch (e) {
      next(e as Error);
    }
  });
}

const baseOptions = { timestamps: true, minimize: false } as const;

/** Fields every document has besides the _id and timestamps. */
const common = { createdBy: { type: Schema.Types.ObjectId } };

// Definitions are typed loosely on purpose: Mongoose's inferred SchemaDefinition types make the compiler very slow
// on a model set this size. Runtime validation comes from the schemas themselves and from Zod at the API edge.
type Def = Record<string, any>;
type IndexSpec = Array<[Record<string, 1 | -1 | 'text'>, Record<string, unknown>?]>;

export function tenantSchema(def: Def, indexes: IndexSpec = []): Schema<any> {
  const s = new Schema<any>({ ...def, ...common } as any, baseOptions as any);
  s.plugin(tenantPlugin);
  // Every index on a tenant collection starts with schoolId. The rare exceptions (TTL indexes, which must
  // be single field, and lookups by a globally unique random value) say so with { noPrefix: true }.
  for (const [fields, opts] of indexes) {
    const { noPrefix, ...rest } = (opts ?? {}) as Record<string, unknown>;
    s.index((noPrefix ? fields : { schoolId: 1, ...fields }) as any, rest as any);
  }
  return s;
}

export function platformSchema(def: Def, indexes: IndexSpec = []): Schema<any> {
  const s = new Schema<any>({ ...def, ...common } as any, baseOptions as any);
  for (const [fields, opts] of indexes) s.index(fields as any, opts as any);
  return s;
}

// Model handles are typed `any`: Mongoose's generic result types make lean() unions and slow the compiler on a
// model set this size. Shapes are enforced by the schemas at runtime and by Zod at the API edge.
export function tenantModel(name: string, schema: Schema<any>, collection?: string): any {
  if (!tenantModelNames.includes(name)) tenantModelNames.push(name);
  return mongoose.models[name] ?? mongoose.model(name, schema as any, collection);
}

export function platformModel(name: string, schema: Schema<any>): any {
  if (!platformModelNames.includes(name)) platformModelNames.push(name);
  return mongoose.models[name] ?? mongoose.model(name, schema as any);
}

export const toId = oid;
export const isObjectId = (v: unknown): v is string => typeof v === 'string' && Types.ObjectId.isValid(v) && String(new Types.ObjectId(v)) === v;
