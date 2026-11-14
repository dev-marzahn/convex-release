import { base, en, Faker } from '@faker-js/faker';
import { expect, test } from 'vite-plus/test';

import { buildDocument } from '../src/seed.ts';

const ref = async (table: string) => `${table}-id` as never;

test('evaluates generators in order, so later fields see earlier ones', async () => {
  const faker = new Faker({ locale: [en, base] });
  const doc = await buildDocument(
    {
      text: () => 'hello',
      length: ({ doc }: { doc: { text: string } }) => doc.text.length,
      authorId: ({ ref }: { ref: (t: string) => Promise<string> }) => ref('users'),
      role: 'member',
    },
    { faker, i: 0, ref },
  );
  expect(doc).toEqual({ text: 'hello', length: 5, authorId: 'users-id', role: 'member' });
});

test('leaves out fields that come out undefined', async () => {
  const faker = new Faker({ locale: [en, base] });
  const doc = await buildDocument({ nickname: ({ i }: { i: number }) => (i % 2 ? 'odd' : undefined), name: 'x' }, { faker, i: 2, ref });
  expect(doc).toEqual({ name: 'x' });
});

test('the same seed gives the same document', async () => {
  const fields = { name: ({ faker }: { faker: Faker }) => faker.person.fullName(), email: ({ faker }: { faker: Faker }) => faker.internet.email() };
  const make = async (i: number) => {
    const faker = new Faker({ locale: [en, base] });
    faker.seed([1, i]);
    return buildDocument(fields, { faker, i, ref });
  };
  expect(await make(7)).toEqual(await make(7));
  expect(await make(7)).not.toEqual(await make(8));
});
