// One-off: add boards to the DB. Run: node scripts/add-boards-batch.mjs
// Idempotent on slug; appends after the current max sort_order. Mirrors index.html FALLBACK_BOARDS.
import dotenv from 'dotenv'; dotenv.config({ path: '.env.local' });
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });

const BOARDS = [
  { slug:'cereals-adults-like', icon:'🥣', color:0, title:'Cereals Adults Like',
    answers:['Cheerios','Wheaties','Corn Flakes','Rice Krispies','Raisin Bran','Total','Shredded Wheat','Special K','Bran Flakes','Product 19'],
    decoys:['Grape-Nuts','All-Bran','Cracklin’ Oat Bran','Müeslix','Life','Kix','Chex','Oatmeal Squares','Fiber One','Grape-Nuts Flakes'] },
  { slug:'kids-bathtime', icon:'🛁', color:1, title:'Things Little Kids Use at Bathtime',
    answers:['Soap','Shampoo','Washcloth','Bubble bath','Towel','Water','Boat','Toys','Sponge','Rubber duckie'],
    decoys:['Conditioner','Loofah','Bath crayons','Squirt gun','Bath robe','Cup','Foam letters','Shower cap','Tub mat','Bath book'] },
  { slug:'sweet-cereals-brands', icon:'🍭', color:2, title:'Sweet Cereals (Brands)',
    answers:['Froot Loops','Frosted Flakes','Corn Pops','Lucky Charms','Cap’n Crunch','Apple Jacks','Honeycombs','Cocoa Puffs','Super Golden Crisp','Croonchy Stars'],
    decoys:['Trix','Cocoa Pebbles','Fruity Pebbles','Cinnamon Toast Crunch','Cookie Crisp','Frosted Mini-Wheats','Honey Smacks','Reese’s Puffs','Count Chocula','Cinnamon Grahams'] },
];

await c.connect();
let { rows:[m] } = await c.query(`SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM boards`);
let sort = m.n;
for (const B of BOARDS) {
  const { rows:[b] } = await c.query(
    `INSERT INTO boards (slug,title,icon,color_slot,sort_order) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (slug) DO UPDATE SET title=EXCLUDED.title, icon=EXCLUDED.icon, color_slot=EXCLUDED.color_slot
     RETURNING id`,
    [B.slug, B.title, B.icon, B.color, sort++]
  );
  await c.query(`DELETE FROM board_answers WHERE board_id=$1`, [b.id]);
  const tiles = [...B.answers.map((t,j)=>[b.id,t,true,j]), ...B.decoys.map((t,j)=>[b.id,t,false,100+j])];
  for (const [bid,text,on,ord] of tiles) await c.query(`INSERT INTO board_answers (board_id,text,on_list,sort_order) VALUES ($1,$2,$3,$4)`,[bid,text,on,ord]);
  console.log(`✓ ${B.title} → board id ${b.id} (${B.answers.length} answers + ${B.decoys.length} decoys)`);
}
const { rows:[cnt] } = await c.query(`SELECT COUNT(*) AS boards FROM boards`);
console.log('total boards now:', cnt.boards);
await c.end();
