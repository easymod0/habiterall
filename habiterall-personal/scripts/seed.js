/**
 * Seeds a few months of plausible history so the charts have something to
 * show on a fresh install. Safe to skip entirely — the app works empty.
 *
 *   node scripts/seed.js
 */
import { db, YES, SKIP } from '../src/db.js';
import { toISO } from '@habiterall/shared/stats.js';

const existing = db.prepare('SELECT COUNT(*) AS n FROM habits').get();
if (existing.n > 0) {
  console.log(`Database already has ${existing.n} habit(s); refusing to seed.`);
  console.log('Delete the database file first if you want fresh sample data.');
  process.exit(0);
}

const insertHabit = db.prepare(`
  INSERT INTO habits (name, description, type, unit, target_value, target_type,
                      freq_numerator, freq_denominator, color, position)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertEntry = db.prepare(
  `INSERT OR REPLACE INTO entries (habit_id, date, value, notes) VALUES (?, ?, ?, '')`
);

const habits = [
  {
    name: 'Meditate', description: '10 minutes after waking',
    type: 'boolean', unit: '', target: 0, targetType: 'at_least',
    num: 1, den: 1, color: '#8b5cf6',
    // strong habit with the occasional lapse
    roll: (dow, i) => (i % 13 === 0 ? SKIP : Math.random() < 0.88 ? YES : 0),
  },
  {
    name: 'Read', description: 'Pages before bed',
    type: 'numerical', unit: 'pages', target: 20, targetType: 'at_least',
    num: 1, den: 1, color: '#0ea5e9',
    roll: () => Math.round(Math.random() * 34),
  },
  {
    name: 'Gym', description: 'Strength training',
    type: 'boolean', unit: '', target: 0, targetType: 'at_least',
    num: 3, den: 7, color: '#f59e0b',
    // Mon / Wed / Fri, missed sometimes
    roll: (dow) => ([1, 3, 5].includes(dow) && Math.random() < 0.8 ? YES : 0),
  },
  {
    name: 'No late-night snacks', description: 'Nothing after 9pm',
    type: 'numerical', unit: 'snacks', target: 0, targetType: 'at_most',
    num: 1, den: 1, color: '#10b981',
    roll: () => (Math.random() < 0.72 ? 0 : Math.ceil(Math.random() * 2)),
  },
  {
    name: 'Water', description: 'Stay hydrated',
    type: 'numerical', unit: 'glasses', target: 8, targetType: 'at_least',
    num: 1, den: 1, color: '#3b82f6',
    roll: () => 3 + Math.floor(Math.random() * 7),
  },
];

const DAYS = 180;
let entryCount = 0;

db.prepare('BEGIN').run();
try {
  habits.forEach((h, position) => {
    const info = insertHabit.run(
      h.name, h.description, h.type, h.unit, h.target,
      h.targetType, h.num, h.den, h.color, position
    );
    const id = info.lastInsertRowid;

    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - i);

      const value = h.roll(d.getDay(), i);
      // Boolean "no" is stored as absence, matching the API's behaviour.
      if (h.type === 'boolean' && value === 0) continue;
      insertEntry.run(id, toISO(d), value);
      entryCount++;
    }
  });
  db.prepare('COMMIT').run();
} catch (e) {
  db.prepare('ROLLBACK').run();
  throw e;
}

console.log(`Seeded ${habits.length} habits and ${entryCount} entries over ${DAYS} days.`);
db.close();
