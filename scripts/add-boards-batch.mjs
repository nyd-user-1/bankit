// One-off: add the four new boards to the DB. Run: node scripts/add-boards-batch.mjs
// Idempotent on slug; appends after the current max sort_order. Mirrors index.html FALLBACK_BOARDS.
import dotenv from 'dotenv'; dotenv.config({ path: '.env.local' });
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });

const BOARDS = [
  { slug:'jelly-bean-colors', icon:'🫘', color:0, title:'Jelly Bean Colors',
    answers:['Red','Black','Orange','Yellow','Green','Purple','Pink','White','Brown','Aqua'],
    decoys:['Teal','Magenta','Lime','Gold','Silver','Tan','Maroon','Navy','Gray','Coral'] },
  { slug:'girls-names-4-letters', icon:'👧', color:1, title:'Girls’ Names With 4 Letters',
    answers:['Mary','Kris','Jill','Lynn','Jean','Beth','Tina','Lisa','Cary','Jody'],
    decoys:['Anna','Erin','Gail','Joan','Kara','Nina','Ruth','Sara','Toni','Dawn'] },
  { slug:'fast-food-places', icon:'🍔', color:2, title:'Fast-Food Places',
    answers:['McDonald’s','Burger King','Taco Bell','Arby’s','Kentucky Fried Chicken','Wendy’s','Pizza Hut','Dairy Queen','Popeye’s','Jack-in-the-Box'],
    decoys:['Subway','Chick-fil-A','Hardee’s','Sonic','Carl’s Jr.','White Castle','Long John Silver’s','Five Guys','Domino’s','Chipotle'] },
  { slug:'sour-things', icon:'🤢', color:3, title:'Sour Things',
    answers:['Lemon','Lime','Dill pickle','Vinegar','Lemonade','Grapefruit','Spoiled milk','Sour cream','Bad grapes','Sour ball candy'],
    decoys:['Green apple','Tamarind','Sauerkraut','Buttermilk','Cranberries','Kombucha','Sourdough bread','Yogurt','Rhubarb','Kimchi'] },
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
