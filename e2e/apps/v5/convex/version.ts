import { query } from './_generated/server';

/** Only v5 has this: whether it answers tells which code is live. */
export const get = query({ args: {}, handler: () => 'v5' });
