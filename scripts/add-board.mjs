// Add one board to the DB. Edit BOARD below, then: node scripts/add-board.mjs
import dotenv from 'dotenv'; dotenv.config({ path: '.env.local' });
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });

const BOARD = {
  slug:'things-in-a-parade', icon:'🎉', color:1, title:'Things in a Parade',
  answers:['Marching band','Floats','Crowds','Clowns','Balloons','Horses','Police','Cars','Unicycles','Flags'],
  decoys:['Fireworks','Drum major','Confetti','Mascots','Bicycles','Dancers','Tractors','Stilts','Cheerleaders','Fire trucks'],
};

await c.connect();
// color_slot cycles 0..3; append after the current max sort_order
const { rows:[m] } = await c.query(`SELECT COALESCE(MAX(sort_order),-1)+1 AS n, COUNT(*) AS cnt FROM boards`);
const sort = m.n;
const { rows:[b] } = await c.query(
  `INSERT INTO boards (slug,title,icon,color_slot,sort_order) VALUES ($1,$2,$3,$4,$5)
   ON CONFLICT (slug) DO UPDATE SET title=EXCLUDED.title, icon=EXCLUDED.icon, color_slot=EXCLUDED.color_slot
   RETURNING id`,
  [BOARD.slug, BOARD.title, BOARD.icon, BOARD.color, sort]
);
await c.query(`DELETE FROM board_answers WHERE board_id=$1`, [b.id]);
const tiles = [...BOARD.answers.map((t,j)=>[b.id,t,true,j]), ...BOARD.decoys.map((t,j)=>[b.id,t,false,100+j])];
for (const [bid,text,on,ord] of tiles) await c.query(`INSERT INTO board_answers (board_id,text,on_list,sort_order) VALUES ($1,$2,$3,$4)`,[bid,text,on,ord]);
console.log(`✓ ${BOARD.title} → board id ${b.id} (${BOARD.answers.length} answers + ${BOARD.decoys.length} decoys)`);
const { rows:[cnt] } = await c.query(`SELECT COUNT(*) AS boards FROM boards`);
console.log('total boards now:', cnt.boards);
await c.end();
