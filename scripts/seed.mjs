// Seed Bank It's DB with the 4 boards currently hardcoded in index.html.
// Run: node scripts/seed.mjs   (loads .env.local for DATABASE_URL)
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import pg from 'pg';
import { readFileSync } from 'node:fs';

const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });

// the boards — kept identical to index.html's BOARDS array
const BOARDS = [
  { slug:'goes-with-milk', icon:'🥛', color:0, title:'Things That Go Well With Milk',
    answers:['Cookies','Cake','Cereal','Graham crackers','Brownies','Doughnuts','Sandwich','Pie','Bananas','Chocolate syrup'],
    decoys:['Toast','Crackers','Muffins','Oatmeal','Popcorn','Pretzels','Waffles','Candy bar','Marshmallows','Peanut butter'] },
  { slug:'vending-machine-food', icon:'🥤', color:1, title:'Vending Machine Food',
    answers:['Candy bars','Gum','Ice cream','Potato chips','Sandwich','Cookies','Doughnuts','Fruit','Yogurt','Peanuts'],
    decoys:['Pretzels','Crackers','Soda','Bottled water','Granola bar','Trail mix','Popcorn','Beef jerky','Mints','Hot coffee'] },
  { slug:'kool-aid-flavors', icon:'🧃', color:2, title:'Kool-Aid Flavors',
    answers:['Cherry','Orange','Grape','Strawberry','Tropical punch','Raspberry','Lemonade','Lemon-lime','Black cherry','Berry blue'],
    decoys:['Watermelon','Pink lemonade','Blue raspberry','Mango','Peach','Green apple','Kiwi','Pineapple','Fruit punch','Sour apple'] },
  { slug:'christmas-things', icon:'🎄', color:3, title:'Christmas Things',
    answers:['Santa Claus','Christmas tree','Christmas lights','Christmas cards','Manger scene','Gifts','Carolers','Christmas cookies','Christmas play','Wreaths'],
    decoys:['Snowman','Stockings','Mistletoe','Reindeer','Candy canes','Sleigh','Ornaments','Elves','Nutcracker','Snowflakes'] },
];

await c.connect();
console.log('Applying schema…');
await c.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

console.log('Seeding boards…');
for (let i = 0; i < BOARDS.length; i++) {
  const b = BOARDS[i];
  const { rows } = await c.query(
    `INSERT INTO boards (slug,title,icon,color_slot,sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [b.slug, b.title, b.icon, b.color, i]
  );
  const boardId = rows[0].id;
  const tiles = [
    ...b.answers.map((t, j) => [boardId, t, true, j]),
    ...b.decoys.map((t, j) => [boardId, t, false, 100 + j]),
  ];
  for (const [bid, text, on, ord] of tiles) {
    await c.query(`INSERT INTO board_answers (board_id,text,on_list,sort_order) VALUES ($1,$2,$3,$4)`, [bid, text, on, ord]);
  }
  console.log(`  ✓ ${b.title} (${b.answers.length} answers + ${b.decoys.length} decoys)`);
}

// a few mock leaderboard rows so /api/scores returns something before real play
console.log('Seeding sample scores…');
const samples = [
  ['FoxBanker','🦊',null,10,'clear'], ['NullPointer','🐙',null,9,'banked'],
  ['BeeKeeper','🐝',null,8,'banked'], ['RibbitRich','🐸',null,7,'banked'],
];
for (const s of samples) {
  await c.query(`INSERT INTO scores (player_name,avatar,board_id,score,how_ended) VALUES ($1,$2,$3,$4,$5)`, s);
}

const counts = await c.query(`SELECT
  (SELECT count(*) FROM boards) boards,
  (SELECT count(*) FROM board_answers) answers,
  (SELECT count(*) FROM scores) scores`);
console.log('Done →', counts.rows[0]);
await c.end();
