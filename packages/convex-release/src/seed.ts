// The seeding half of convex-release, imported by the generated
// `convex/seeds/_generated.ts`. Apps write `export default defineSeed(...)` in
// files under `convex/seeds/`; the CLI generates the wiring and runs them in
// filename order.
//
// A separate entry point from the migrations library, so faker only ends up in
// a Convex bundle that has seeds.
import { base, en, Faker } from '@faker-js/faker';
import {
  getFunctionName,
  internalActionGeneric,
  internalMutationGeneric,
  type DocumentByName,
  type FunctionReference,
  type GenericDataModel,
  type GenericMutationCtx,
  type RegisteredAction,
  type RegisteredMutation,
  type TableNamesInDataModel,
  type WithoutSystemFields,
} from 'convex/server';
import { v, type GenericId } from 'convex/values';

export type { Faker };

/** What a field generator gets. */
export interface FieldContext<DataModel extends GenericDataModel, Doc = Record<string, unknown>> {
  /** Seeded per document, so every run writes the same data. */
  faker: Faker;
  /** The document's number in this seed, from 0. For unique values: `` `user${i}@example.com` ``. */
  i: number;
  /** The fields generated so far, in the order `fields` lists them: `length: ({ doc }) => doc.text!.length`. */
  doc: Partial<Doc>;
  /**
   * The id of a document in `table`, picked at random from its first 1000.
   * Seed that table in an earlier file.
   */
  ref: <Table extends TableNamesInDataModel<DataModel>>(table: Table) => Promise<GenericId<Table>>;
}

/** A fixed value, or a function that returns one. */
export type FieldGenerator<DataModel extends GenericDataModel, Value, Doc = Record<string, unknown>> =
  | Value
  | ((s: FieldContext<DataModel, Doc>) => Value | Promise<Value>);

type NewDocument<DataModel extends GenericDataModel, Table extends TableNamesInDataModel<DataModel>> = WithoutSystemFields<DocumentByName<DataModel, Table>>;

/** One generator per field of the table. Optional fields can be left out. */
export type SeedFields<DataModel extends GenericDataModel, Table extends TableNamesInDataModel<DataModel>> = {
  [Field in keyof NewDocument<DataModel, Table>]: FieldGenerator<DataModel, NewDocument<DataModel, Table>[Field], NewDocument<DataModel, Table>>;
};

export interface TableSeed<DataModel extends GenericDataModel, Table extends TableNamesInDataModel<DataModel>> {
  /** How many documents to write. */
  count: number;
  fields: SeedFields<DataModel, Table>;
  /** Documents per transaction. Default 100. */
  batchSize?: number;
}

/** A seed written by hand. It runs in one mutation, so it gets one mutation's write limits. */
export type CustomSeed<DataModel extends GenericDataModel> = (ctx: GenericMutationCtx<DataModel>, s: { faker: Faker }) => void | Promise<void>;

/** One transaction of a seed. */
export interface SeedBatch {
  /** Where the next batch starts, or null when the seed is done. */
  next: number | null;
  written: number;
  /** Set when the deployment had data and the run asked for an empty one. */
  skipped?: string;
}

export interface SeedResult {
  /** False when the deployment already had data and `force` wasn't set. */
  seeded: boolean;
  /** Why nothing was seeded. */
  reason?: string;
  seeds: { name: string; documents: number }[];
}

type SeedArgs = { start: number; requireEmpty: boolean };
export type SeedMutation = RegisteredMutation<'internal', SeedArgs, Promise<SeedBatch>>;
/** Loose on purpose: the generated file's references to its own folder lose their argument types. */
type SeedReference = FunctionReference<'mutation', 'internal'>;
type RunAction = RegisteredAction<'internal', { force?: boolean }, Promise<SeedResult>>;

export interface Seeds<DataModel extends GenericDataModel> {
  /**
   * Writes `count` generated documents to `table`:
   *
   * ```ts
   * export default defineSeed("users", {
   *   count: 50,
   *   fields: {
   *     name: ({ faker }) => faker.person.fullName(),
   *     email: ({ faker, i }) => `user${i}@${faker.internet.domainName()}`,
   *     role: "member",
   *   },
   * });
   * ```
   */
  defineSeed<Table extends TableNamesInDataModel<DataModel>>(table: Table, definition: TableSeed<DataModel, Table>): SeedMutation;
  /** Runs your own code: `defineSeed(async (ctx, { faker }) => { ... })`. */
  defineSeed(seed: CustomSeed<DataModel>): SeedMutation;
  /** The action that runs the seeds in order. */
  runner(list: SeedReference[]): RunAction;
}

/** The schema's table names, to check whether the deployment is empty. */
interface Schema {
  tables: Record<string, unknown>;
}

export function createSeeds<DataModel extends GenericDataModel>(schema: Schema): Seeds<DataModel> {
  const tables = Object.keys(schema.tables);

  async function firstNonEmpty(ctx: GenericMutationCtx<DataModel>): Promise<string | undefined> {
    for (const table of tables) {
      if (await ctx.db.query(table).first()) return table;
    }
    return undefined;
  }

  function seedMutation(write: (ctx: GenericMutationCtx<DataModel>, start: number) => Promise<Omit<SeedBatch, 'skipped'>>): SeedMutation {
    return internalMutationGeneric({
      args: { start: v.number(), requireEmpty: v.boolean() },
      handler: async (ctx, { start, requireEmpty }): Promise<SeedBatch> => {
        if (requireEmpty) {
          const table = await firstNonEmpty(ctx as GenericMutationCtx<DataModel>);
          if (table) return { next: null, written: 0, skipped: `the deployment already has data (in \`${table}\`)` };
        }
        return write(ctx as GenericMutationCtx<DataModel>, start);
      },
    }) as SeedMutation;
  }

  function defineSeed(tableOrSeed: string | CustomSeed<DataModel>, definition?: TableSeed<DataModel, never>): SeedMutation {
    if (typeof tableOrSeed === 'function') {
      return seedMutation(async (ctx) => {
        const counted = countInserts(ctx);
        await tableOrSeed(counted.ctx, { faker: newFaker(hash(tableOrSeed.toString())) });
        return { next: null, written: counted.count() };
      });
    }
    const table = tableOrSeed;
    const { count, fields, batchSize = 100 } = definition!;
    return seedMutation(async (ctx, start) => {
      const end = Math.min(count, start + batchSize);
      const faker = newFaker(0);
      const ref = idPicker(ctx, faker);
      for (let i = start; i < end; i++) {
        faker.seed([hash(table), i]);
        await ctx.db.insert(table, (await buildDocument(fields as Record<string, unknown>, { faker, i, ref })) as never);
      }
      return { next: end < count ? end : null, written: Math.max(0, end - start) };
    });
  }

  return {
    defineSeed: defineSeed as Seeds<DataModel>['defineSeed'],

    runner(list) {
      return internalActionGeneric({
        args: { force: v.optional(v.boolean()) },
        handler: async (ctx, { force = false }): Promise<SeedResult> => {
          const seeds: SeedResult['seeds'] = [];
          for (const [index, fn] of list.entries()) {
            let start: number | null = 0;
            let documents = 0;
            while (start !== null) {
              const batch = (await ctx.runMutation(fn, { start, requireEmpty: !force && index === 0 && start === 0 })) as SeedBatch;
              if (batch.skipped) return { seeded: false, reason: batch.skipped, seeds: [] };
              documents += batch.written;
              start = batch.next;
            }
            seeds.push({ name: getFunctionName(fn), documents });
          }
          return { seeded: true, seeds };
        },
      }) as RunAction;
    },
  };
}

/** Evaluates each field's generator in order. Fields that come out `undefined` are left out. */
export async function buildDocument(fields: Record<string, unknown>, s: Omit<FieldContext<GenericDataModel>, 'doc'>): Promise<Record<string, unknown>> {
  const doc: Record<string, unknown> = {};
  for (const [field, generator] of Object.entries(fields)) {
    const value = typeof generator === 'function' ? await (generator as (s: FieldContext<GenericDataModel>) => unknown)({ ...s, doc }) : generator;
    if (value !== undefined) doc[field] = value;
  }
  return doc;
}

function newFaker(seed: number): Faker {
  const faker = new Faker({ locale: [en, base] });
  faker.seed(seed);
  return faker;
}

/** `ref(table)`: ids of the table's first 1000 documents, read once per batch. */
function idPicker<DataModel extends GenericDataModel>(ctx: GenericMutationCtx<DataModel>, faker: Faker) {
  const cache = new Map<string, GenericId<string>[]>();
  return async <Table extends string>(table: Table): Promise<GenericId<Table>> => {
    let ids = cache.get(table);
    if (!ids) {
      ids = (await ctx.db.query(table).take(1000)).map((doc) => doc._id as GenericId<string>);
      cache.set(table, ids);
    }
    if (ids.length === 0) throw new Error(`ref("${table}"): \`${table}\` has no documents yet. Seed it in an earlier file.`);
    return faker.helpers.arrayElement(ids) as GenericId<Table>;
  };
}

/** The same ctx, counting `db.insert` calls for the run's report. */
function countInserts<DataModel extends GenericDataModel>(ctx: GenericMutationCtx<DataModel>) {
  let count = 0;
  const db = new Proxy(ctx.db, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property === 'insert') {
        return (...args: Parameters<typeof target.insert>) => {
          count++;
          return target.insert(...args);
        };
      }
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ctx: { ...ctx, db }, count: () => count };
}

/** FNV-1a: a stable number per table, so each table gets its own data. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
