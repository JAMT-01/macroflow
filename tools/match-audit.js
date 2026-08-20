// Which library entries act as "magnets" — catching compound dish names via the
// substring rule and overwriting the model's macros?
const fs = require('fs');
const path = require('path');
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'foods.json'), 'utf8'));
const foods = raw[0].results;

const clean = (v) => v.toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function matchFood(foods, name) {
  const target = clean(name);
  let best;
  for (const food of foods) {
    for (const alias of [food.name, ...JSON.parse(food.aliases)].map(clean)) {
      let score = 0;
      if (target === alias) score = 1e3 + alias.length;
      else if (target.includes(alias)) score = 500 + alias.length;
      else if (alias.includes(target) && target.length >= 4) score = 100 + target.length;
      if (score > (best?.score ?? 0)) best = { food, score, alias };
    }
  }
  return best;
}

// Realistic dishes an Argentine food log would actually contain.
const dishes = [
  'arroz italiano', 'arroz con pollo', 'risotto de hongos', 'arroz integral con verduras',
  'atun en aceite de oliva', 'tuna in olive oil', 'ensalada de atun',
  'pan con aceite de oliva', 'papas al horno con aceite de oliva',
  'banana bread', 'licuado de banana', 'budin de banana',
  'batata frita', 'sweet potato fries', 'pure de papas con manteca',
  'pollo al curry', 'chicken curry', 'pollo a la parrilla',
  'milanesa napolitana', 'tarta de manzana', 'apple pie',
  'yogur con granola', 'huevos revueltos con queso', 'tostada con palta',
  'helado de dulce de leche', 'alfajor de maicena',
];

const magnets = new Map();
let substringHits = 0;

console.log('DISH'.padEnd(36) + 'SNAPPED TO'.padEnd(30) + 'VIA ALIAS');
console.log('-'.repeat(92));
for (const dish of dishes) {
  const hit = matchFood(foods, dish);
  if (!hit) { console.log(dish.padEnd(36) + '(model values kept)'); continue; }
  const kind = hit.score >= 1000 ? 'EXACT' : hit.score >= 500 ? 'substring' : 'reverse';
  if (kind === 'substring') {
    substringHits++;
    magnets.set(hit.alias, (magnets.get(hit.alias) ?? 0) + 1);
  }
  console.log(dish.padEnd(36) + hit.food.name.padEnd(30) + `${kind}  "${hit.alias}"`);
}

console.log('-'.repeat(92));
console.log(`${substringHits} of ${dishes.length} dishes overwritten by a substring match\n`);
console.log('MAGNET ALIASES (catching compound dishes):');
[...magnets.entries()].sort((a, b) => b[1] - a[1]).forEach(([alias, n]) => {
  const owner = foods.find((f) => [f.name, ...JSON.parse(f.aliases)].map(clean).includes(alias));
  const isName = clean(owner.name) === alias;
  console.log(`  "${alias}" ×${n}  → ${owner.name}${isName ? '   [IS THE FOOD NAME — cannot fix via aliases]' : '   [removable alias]'}`);
});
