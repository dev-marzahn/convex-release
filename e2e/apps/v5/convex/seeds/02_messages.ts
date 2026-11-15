import { defineSeed } from './_generated';

export default defineSeed('messages', {
  count: 250,
  fields: {
    text: ({ faker }) => faker.lorem.sentence(),
    length: ({ doc }) => doc.text!.length,
    authorId: ({ ref }) => ref('users'),
  },
});
