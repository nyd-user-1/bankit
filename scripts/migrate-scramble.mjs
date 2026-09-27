// scramble_words (idempotent): the shared word pool for Scramble. Seeds the 500 starter words;
// words the AI adds later (api/scramble.js) land here too, so every player shares them.
//   node scripts/migrate-scramble.mjs
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
require('dotenv').config({ path: path.join(ROOT, '.env.local'), quiet: true });
const { getPool } = require('../api/_db.js');

const WORDS = `
apple beach bread brick cabin candy chair cheese cloud clock coast crown dance dream eagle earth
feast field flame flute fruit ghost giant glass grape heart horse house igloo jelly juice knife
lemon light magic maple melon money mouse music night ocean olive onion otter paint party pearl
piano pilot pizza plant queen quilt radio river robot salad shark sheep shell smile snake space
spoon storm sugar table tiger toast torch tower train water whale wheel world zebra animal
banana basket button camera candle carrot castle circus cookie dragon flower forest garden
guitar hammer island jacket jungle kitten ladder lizard market marble mirror monkey muffin
orange parrot pencil pepper pickle planet pretzel puzzle rabbit rocket saddle school silver
spider summer tomato turtle violin wallet window winter wizard balloon biscuit blanket cabbage
captain cartoon chicken compass dolphin giraffe hamster harvest lantern library mustard octopus
pancake penguin pumpkin rainbow sunrise teacher thunder trumpet unicorn volcano weather acorn
actor adult agent alarm album alien angel angle ankle apron arena arrow attic award bacon badge
bagel baker bamboo banjo barrel basin baton beard beast bench berry bingo birch blade blaze
blend blimp block bloom board boots bottle bounce brain brave bridge broom brush bubble bucket
buddy budget buffet bugle bunny burger butter cactus camel canal canoe canyon carpet cattle
cedar cereal chalk charm chart chase cherry chess chest chimney choir cider cinema cleaner cliff
cloak clover coach cocoa coconut coffee comet comic coral cotton couch cougar cousin cover
coyote cradle crane crate crayon cream creek cricket crumb crust crystal cupcake curtain cushion
daisy desert diamond dinner doctor donkey donut dough dozen drawer dress drift drink drive easel
eclipse elbow engine eraser fabric fairy falcon farmer faucet feather fence ferry fiddle finger
fleece flock float flour fossil frame freezer frost galaxy gallon garage gecko gentle ginger
glove goose gopher gravy grill guard guest habit haircut hallway harbor hazel helmet hiker
hockey honey hoodie hotel iguana infant insect ivory jaguar jeans jewel jigsaw kayak kernel
kettle kidney koala label lagoon leader leash lettuce lever limit linen lobster locket lotion
lunch magnet mango manor marsh meadow medal meteor minute mitten model moose morning motor mound
muscle napkin nature nectar needle nephew noodle nugget oatmeal office orbit orchid oyster
paddle palace panda panther paper parade parcel pasta pastry patio peach peanut pebble pelican
penny petal pigeon pillow pirate plaza pocket polar popcorn poster potato powder prince prism
puppy purple quarter quiver raccoon radar rafter raisin ranch raven razor recipe ribbon riddle
robin rodeo roller rooster rubber ruler sailor salmon sandal sauce sausage scarf scooter season
secret seesaw shadow shelf sheriff shovel shower signal singer sister skate sketch skillet skunk
slipper sloth snack sneaker snowman soccer socks soldier sparrow spice sponge spring squid
stable stadium stamp statue steam stereo sticker stone stool stream street string student studio
subway sunset supper surfer sweater sword syrup talent teapot temple tennis thread throne ticket
timber toaster toffee tongue tooth tractor trail trophy truck tulip tunnel turkey tuxedo uncle
vacuum valley vanilla velvet
`.trim().split(/\s+/);

const pool = getPool();
await pool.query(`
  CREATE TABLE IF NOT EXISTS scramble_words (
    word       TEXT PRIMARY KEY,               -- lowercase a–z, 5–7 letters
    source     TEXT NOT NULL DEFAULT 'seed',   -- seed · ai
    added_by   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
await pool.query(`INSERT INTO scramble_words (word) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`, [WORDS]);
const { rows } = await pool.query(`SELECT source, count(*)::int AS n FROM scramble_words GROUP BY source`);
console.log('scramble_words ready:', rows);
