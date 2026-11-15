// What a predeploy check module sees: the types and the one constant library
// authors use. No imports, so `index.ts` can re-export it without pulling
// Node built-ins into the code that runs inside Convex.

/** The `code` of a query error whose target component is missing or unmounted on the deployment. */
export const COMPONENT_NOT_DEPLOYED = 'COMPONENT_NOT_DEPLOYED';

/** What `collect` receives: where the app's source is. */
export interface PredeployCollectContext {
  projectRoot: string;
  /** The app's functions folder. */
  convexDir: string;
}

/** What `check` receives. */
export interface PredeployCheckContext {
  /** What `collect` returned for the release being deployed. */
  facts: unknown;
  /**
   * Calls a query on the deployment. Rejects with `code: 'COMPONENT_NOT_DEPLOYED'`
   * when the target component is missing or unmounted, as on the release that
   * first adds the library, and with a plain error for any other failure.
   */
  query<T>(target: { componentPath?: string; path: string }, args?: object): Promise<T>;
  log(message: string): void;
}

export type PredeployResult = { ok: true } | { ok: false; message: string; details?: string[] };
