import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, deleteFlight, flightKey, listFlights, saveFlight } from '../src/library';
import { pairVideos, toNaiveLocal } from '../src/pairing';

const summary = { duration: 60 };

describe('bibliothèque de vols', () => {
  beforeEach(() => db.flights.clear());

  it('enregistre, trie par date et ne duplique pas un même log', async () => {
    const a = await saveFlight({ key: flightKey('a'), name: 'a.csv', date: 1000, csv: 'a', summary });
    await saveFlight({ key: flightKey('b'), name: 'b.csv', date: 2000, csv: 'b', summary });
    const again = await saveFlight({ key: flightKey('a'), name: 'a.csv', date: 1000, csv: 'a', summary });
    expect(again).toBe(a);
    const list = await listFlights();
    expect(list.map((f) => f.name)).toEqual(['b.csv', 'a.csv']);
  });

  it('garde la vidéo déjà associée quand on réimporte le log seul', async () => {
    const video = { name: 'v.srt', samples: [{ t: 0, signal: 4 }], fields: ['t', 'signal'] };
    const id = await saveFlight({ key: 'k', name: 'a.csv', date: 1, csv: 'a', summary, video, videoOffset: 3 });
    await saveFlight({ key: 'k', name: 'a.csv', date: 1, csv: 'a', summary });
    const f = await db.flights.get(id);
    expect(f?.video?.name).toBe('v.srt');
    expect(f?.videoOffset).toBe(3);
  });

  it('supprime un vol', async () => {
    const id = await saveFlight({ key: 'x', name: 'x.csv', date: 1, csv: 'x', summary });
    await deleteFlight(id);
    expect(await listFlights()).toHaveLength(0);
  });
});

describe('association vidéo ↔ log', () => {
  const min = 60000;
  const logs = [
    { id: 'vol1', start: 0, end: 10 * min },
    { id: 'vol2', start: 30 * min, end: 40 * min },
  ];

  it('associe chaque vidéo au log qui la recouvre', () => {
    const pairs = pairVideos(logs, [
      { id: 'a', start: 1 * min, end: 9 * min },
      { id: 'b', start: 31 * min, end: 38 * min },
      { id: 'c', start: 100 * min, end: 105 * min },
    ]);
    expect(pairs.get('a')).toBe('vol1');
    expect(pairs.get('b')).toBe('vol2');
    expect(pairs.has('c')).toBe(false);
  });

  it('convertit une heure réelle en heure locale naïve', () => {
    // UTC+2 (getTimezoneOffset = -120)
    expect(toNaiveLocal(Date.UTC(2026, 5, 1, 10, 0), -120)).toBe(Date.UTC(2026, 5, 1, 12, 0));
  });
});
