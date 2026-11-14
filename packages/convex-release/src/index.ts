// The runtime half of convex-release, imported by the generated
// `convex/migrations/_generated.ts`. Apps don't call this directly: they write
// `export default defineMigration({...})` in numbered files and the CLI
// generates the wiring.
import { Migrations, type MigrationFunctionReference } from '@convex-dev/migrations';
import {
  createFunctionHandle,
  getFunctionName,
  internalMutationGeneric,
  internalQueryGeneric,
  type DocumentByName,
  type GenericDataModel,
  type GenericMutationCtx,
  type NamedTableInfo,
  type OrderedQuery,
  type QueryInitializer,
  type RegisteredMutation,
  type RegisteredQuery,
  type TableNamesInDataModel,
} from 'convex/server';
import type { GenericId } from 'convex/values';

/**
 * A document as a migration sees it. It may be in any older shape: fields of
 * the current schema can be missing, and fields the schema no longer has can
 * still be there.
 */
export type OldDocument<DataModel extends GenericDataModel, Table extends TableNamesInDataModel<DataModel>> = Partial<DocumentByName<DataModel, Table>> & {
  _id: GenericId<Table>;
  _creationTime: number;
  [field: string]: unknown;
};

/** Fields to set on the document. Set a field to `undefined` to remove it. */
export type DocumentPatch<DataModel extends GenericDataModel, Table extends TableNamesInDataModel<DataModel>> = Partial<DocumentByName<DataModel, Table>> & {
  [field: string]: unknown;
};

export interface MigrationDefinition<DataModel extends GenericDataModel, Table extends TableNamesInDataModel<DataModel>> {
  /** The table whose documents this migration visits. */
  table: Table;
  /**
   * Called once per document. Return the fields to change, or nothing to leave
   * the document as it is. It must be safe to run twice on the same document:
   * check whether the document still needs the change first.
   */
  migrateOne: (
    ctx: GenericMutationCtx<DataModel>,
    doc: OldDocument<DataModel, Table>,
  ) => void | DocumentPatch<DataModel, Table> | Promise<void | DocumentPatch<DataModel, Table>>;
  /** Only visit these documents, e.g. `(q) => q.withIndex("by_status", ...)`. */
  customRange?: (q: QueryInitializer<NamedTableInfo<DataModel, Table>>) => OrderedQuery<NamedTableInfo<DataModel, Table>>;
  /** Documents per transaction. Default 100. */
  batchSize?: number;
  /** Run a batch's documents concurrently instead of one by one. */
  parallelize?: boolean;
}

/** What `status` reports to the CLI and the image entrypoint. */
export interface ReleaseStatus {
  state: 'running' | 'done' | 'failed';
  message?: string;
}

export interface UpgradeOptions {
  /**
   * Don't treat finished migrations this release doesn't know as a downgrade.
   * Only needed if migrations were run by hand outside the numbered files.
   */
  allowUnknown?: boolean;
}

type MigrationsComponent = ConstructorParameters<typeof Migrations>[0];
type StartMutation = RegisteredMutation<'internal', Record<string, never>, Promise<null>>;
type StatusQuery = RegisteredQuery<'internal', Record<string, never>, Promise<ReleaseStatus>>;

export interface Release<DataModel extends GenericDataModel> {
  /** The underlying @convex-dev/migrations instance. */
  migrations: Migrations<DataModel>;
  defineMigration<Table extends TableNamesInDataModel<DataModel>>(
    definition: MigrationDefinition<DataModel, Table>,
  ): ReturnType<Migrations<DataModel>['define']>;
  /** `start` and `status` for the given migrations, oldest first. */
  upgrade(list: MigrationFunctionReference[], options?: UpgradeOptions): { start: StartMutation; status: StatusQuery };
}

export function createRelease<DataModel extends GenericDataModel>(component: MigrationsComponent): Release<DataModel> {
  const migrations = new Migrations<DataModel>(component);

  return {
    migrations,

    defineMigration(definition) {
      const { migrateOne, ...rest } = definition;
      return migrations.define({
        ...rest,
        // The component types documents with the current schema; at migration
        // time they can be in any older shape.
        migrateOne: (ctx, doc) => migrateOne(ctx, doc as never) as never,
      });
    },

    upgrade(list, options = {}) {
      const names = list.map((fn) => getFunctionName(fn));

      const start = internalMutationGeneric({
        args: {},
        handler: async (ctx) => {
          // Not migrations.runSerially(): after a restart its snapshot read can
          // still show the failed migration in progress, and then it never
          // retries it. This reads fresh and starts at the first unfinished one.
          if (list.length === 0) return null;
          const statuses = await migrations.getStatus(ctx, { migrations: list });
          if (statuses.some((s) => s.state === 'inProgress')) return null;
          const first = statuses.findIndex((s) => !s.isDone);
          if (first === -1) return null;
          const [head, ...rest] = list.slice(first);
          await ctx.runMutation(migrations.component.lib.migrate, {
            name: getFunctionName(head!),
            fnHandle: await createFunctionHandle(head!),
            next: await Promise.all(
              rest.map(async (fn) => ({
                name: getFunctionName(fn),
                fnHandle: await createFunctionHandle(fn),
              })),
            ),
            dryRun: false,
          });
          return null;
        },
      }) as StartMutation;

      const status = internalQueryGeneric({
        args: {},
        handler: async (ctx): Promise<ReleaseStatus> => {
          // A finished migration this release doesn't know was shipped by a
          // newer one: this is a downgrade. An unfinished one was renamed or
          // deleted after it failed, and nothing runs it again.
          if (!options.allowUnknown) {
            const known = new Set(names);
            const recorded = await migrations.getStatus(ctx, { limit: 1000 });
            const unknown = recorded.filter((s) => s.isDone && !known.has(s.name)).map((s) => s.name);
            if (unknown.length > 0) {
              return {
                state: 'failed',
                message: `the data was upgraded by a newer version of the app (migrations not in this one: ${unknown.join(', ')}). Deploy that version or a newer one.`,
              };
            }
          }
          const statuses = list.length > 0 ? await migrations.getStatus(ctx, { migrations: list }) : [];
          const bad = statuses.find((s) => s.state === 'failed' || s.state === 'canceled');
          if (bad) return { state: 'failed', message: `${bad.name} ${bad.state}: ${bad.error ?? ''}` };
          const done = statuses.filter((s) => s.isDone).length;
          return {
            state: done === statuses.length ? 'done' : 'running',
            message: `${done}/${statuses.length} migrations done`,
          };
        },
      }) as StatusQuery;

      return { start, status };
    },
  };
}
