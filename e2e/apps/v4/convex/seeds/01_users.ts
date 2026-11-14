import { defineSeed } from './_generated';

export default defineSeed('users', {
  count: 20,
  fields: {
    name: ({ faker, i }) => `${faker.person.fullName()} ${i}`,
  },
});
