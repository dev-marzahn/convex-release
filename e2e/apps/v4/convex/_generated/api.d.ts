/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as messages from "../messages.js";
import type * as migrations_0001_rename_body_to_text from "../migrations/0001_rename_body_to_text.js";
import type * as migrations_0002_add_length from "../migrations/0002_add_length.js";
import type * as migrations_0003_author_to_users from "../migrations/0003_author_to_users.js";
import type * as migrations__generated from "../migrations/_generated.js";
import type * as nodeHash from "../nodeHash.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  messages: typeof messages;
  "migrations/0001_rename_body_to_text": typeof migrations_0001_rename_body_to_text;
  "migrations/0002_add_length": typeof migrations_0002_add_length;
  "migrations/0003_author_to_users": typeof migrations_0003_author_to_users;
  "migrations/_generated": typeof migrations__generated;
  nodeHash: typeof nodeHash;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
};
