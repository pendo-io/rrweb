import { EventType, IncrementalSource } from '@rrweb/types';
import type { eventWithTime } from '@rrweb/types';

const now = Date.now();

const events: eventWithTime[] = [
  {
    type: EventType.Meta,
    data: { href: 'http://localhost', width: 1200, height: 500 },
    timestamp: now,
  },
  {
    type: EventType.FullSnapshot,
    data: {
      node: {
        id: 1,
        type: 0,
        childNodes: [
          { id: 2, name: 'html', type: 1, publicId: '', systemId: '' },
          {
            id: 3,
            type: 2,
            tagName: 'html',
            attributes: {},
            childNodes: [
              {
                id: 4,
                type: 2,
                tagName: 'head',
                attributes: {},
                childNodes: [],
              },
              {
                id: 5,
                type: 2,
                tagName: 'body',
                attributes: {},
                childNodes: [],
              },
            ],
          },
        ],
      },
      initialOffset: { top: 0, left: 0 },
    },
    timestamp: now,
  },
  {
    type: EventType.IncrementalSnapshot,
    data: {
      source: IncrementalSource.Mutation,
      texts: [],
      attributes: [],
      removes: [],
      adds: [
        {
          parentId: 5,
          nextId: null,
          node: {
            type: 2,
            tagName: 'div',
            attributes: {},
            childNodes: [],
            id: 999,
          },
        },
      ],
    },
    timestamp: now + 200,
  },
  {
    type: EventType.IncrementalSnapshot,
    data: {
      source: IncrementalSource.Mutation,
      texts: [],
      attributes: [{ id: 999, attributes: { 'data-test': 'a' } }],
      removes: [],
      adds: [],
    },
    timestamp: now + 1000,
  },
  {
    type: EventType.IncrementalSnapshot,
    data: {
      source: IncrementalSource.Mutation,
      texts: [],
      attributes: [{ id: 999, attributes: { 'data-test': 'b' } }],
      removes: [],
      adds: [],
    },
    timestamp: now + 2000,
  },
];

export default events;
