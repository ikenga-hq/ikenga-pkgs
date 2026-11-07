/**
 * strictDeep — a copy of a Zod schema in which every object that would
 * silently strip unknown keys rejects them instead.
 *
 * Studio's Zod objects are mostly "strip" objects: Zod drops unknown keys
 * while the exported JSON Schema says `additionalProperties: false`. akuko
 * composes those objects, and the akuko schema must reject everything its
 * JSON Schema rejects, so each composed piece goes through this helper.
 *
 * Objects Studio marks `.passthrough()` (render records, which keep unknown
 * keys across version skew) stay passthrough: their JSON Schema allows extra
 * keys too. Already-strict objects stay strict. The source schema is not
 * modified.
 *
 * Works on type names rather than `instanceof`, so it does not depend on the
 * composed schema sharing this package's copy of Zod.
 */

import type { ZodTypeAny } from 'zod';

type AnyDef = Record<string, unknown> & { typeName?: string };
type Ctor = new (def: AnyDef) => ZodTypeAny;

const rebuild = (s: ZodTypeAny, def: AnyDef): ZodTypeAny => new (s.constructor as Ctor)(def);

export function strictDeep<T extends ZodTypeAny>(schema: T): T {
  return walk(schema) as T;
}

function walk(s: ZodTypeAny): ZodTypeAny {
  const def = s._def as AnyDef;
  switch (def.typeName) {
    case 'ZodObject': {
      const shapeIn = (s as unknown as { shape: Record<string, ZodTypeAny> }).shape;
      const shape = Object.fromEntries(Object.entries(shapeIn).map(([k, v]) => [k, walk(v)]));
      const unknownKeys = def.unknownKeys === 'strip' ? 'strict' : def.unknownKeys;
      return rebuild(s, { ...def, shape: () => shape, unknownKeys });
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
    case 'ZodBranded':
      return rebuild(s, { ...def, innerType: walk(def.innerType as ZodTypeAny) });
    case 'ZodArray':
      return rebuild(s, { ...def, type: walk(def.type as ZodTypeAny) });
    case 'ZodRecord':
      return rebuild(s, { ...def, valueType: walk(def.valueType as ZodTypeAny) });
    case 'ZodUnion':
      return rebuild(s, { ...def, options: (def.options as ZodTypeAny[]).map(walk) });
    case 'ZodEffects':
      return rebuild(s, { ...def, schema: walk(def.schema as ZodTypeAny) });
    case 'ZodDiscriminatedUnion':
    case 'ZodIntersection':
    case 'ZodTuple':
    case 'ZodMap':
    case 'ZodSet':
    case 'ZodLazy':
    case 'ZodPipeline':
    case 'ZodPromise':
    case 'ZodFunction':
      // Not used by any composed schema today; fail loudly rather than leave a hole.
      throw new Error(`strictDeep: ${def.typeName} is not supported`);
    default:
      return s; // scalars, enums, literals, unknown/any
  }
}

/**
 * Every object reachable from `schema` that strips unknown keys, as dotted
 * paths. Used by tests to prove the akuko schema has none.
 */
export function findStripObjects(schema: ZodTypeAny, path = '$', seen = new Set<ZodTypeAny>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = schema._def as AnyDef;
  const out: string[] = [];
  const sub = (child: unknown, p: string) => out.push(...findStripObjects(child as ZodTypeAny, p, seen));
  switch (def.typeName) {
    case 'ZodObject': {
      if (def.unknownKeys === 'strip') out.push(path);
      const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
      for (const [k, v] of Object.entries(shape)) sub(v, `${path}.${k}`);
      break;
    }
    case 'ZodOptional': case 'ZodNullable': case 'ZodDefault': case 'ZodCatch': case 'ZodReadonly': case 'ZodBranded':
      sub(def.innerType, path); break;
    case 'ZodArray': sub(def.type, `${path}[]`); break;
    case 'ZodRecord': sub(def.valueType, `${path}{}`); break;
    case 'ZodUnion': case 'ZodDiscriminatedUnion':
      (def.options as ZodTypeAny[]).forEach((o, i) => sub(o, `${path}|${i}`)); break;
    case 'ZodEffects': sub(def.schema, path); break;
    default: break;
  }
  return out;
}
