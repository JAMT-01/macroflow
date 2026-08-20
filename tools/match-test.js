// Runs the REAL matchFood/clean/calculate from recovered/shared/analysis-core.ts
// against the REAL 45-food library pulled from D1.
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const raw = JSON.parse(fs.readFileSync(path.join(dir, 'foods.json'), 'utf8'));
const foods = raw[0].results;

/* ---- verbatim from recovered/shared/analysis-core.ts ---- */
function clean(value) {
  return value.toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function matchFood(foods, name) {
  const target = clean(name);
  let best;
  for (const food of foods) {
    const aliases = [food.name, ...JSON.parse(food.aliases)].map(clean);
    for (const alias of aliases) {
      let score = 0;
      if (target === alias) score = 1e3 + alias.length;
      else if (target.includes(alias)) score = 500 + alias.length;
      else if (alias.includes(target) && target.length >= 4) score = 100 + target.length;
      if (score > (best?.score ?? 0)) best = { food, score };
    }
  }
  return best;
}
/* -------------------------------------------------------- */

// What the model would plausibly return for the user's meal, with its own
// (correct) macro estimate for the actual dish.
const modelItems = [
  { name: 'Italian rice',        grams: 200, calories: 260, protein: 5.0, carbs: 48, fiber: 1.4, fat: 4.5 },
  { name: 'Arroz italiano',      grams: 200, calories: 260, protein: 5.0, carbs: 48, fiber: 1.4, fat: 4.5 },
  { name: 'Risotto',             grams: 200, calories: 290, protein: 6.0, carbs: 45, fiber: 1.2, fat: 8.0 },
  { name: 'Tuna in olive oil',   grams: 170, calories: 316, protein: 42,  carbs: 0,  fiber: 0,   fat: 16 },
  { name: 'Canned tuna',         grams: 170, calories: 197, protein: 44,  carbs: 0,  fiber: 0,   fat: 1.7 },
  { name: 'Milanesa napolitana', grams: 250, calories: 620, protein: 38,  carbs: 40, fiber: 2.5, fat: 32 },
  { name: 'Sweet potato fries',  grams: 150, calories: 330, protein: 3.0, carbs: 44, fiber: 5.0, fat: 16 },
  { name: 'Banana bread',        grams: 100, calories: 330, protein: 4.3, carbs: 54, fiber: 1.5, fat: 11 },
  { name: 'Almond croissant',    grams: 90,  calories: 400, protein: 8.0, carbs: 38, fiber: 2.5, fat: 24 },
  { name: 'Chicken curry',       grams: 300, calories: 420, protein: 33,  carbs: 14, fiber: 3.0, fat: 25 },
];

console.log('library size:', foods.length, '\n');
console.log('MODEL SAID'.padEnd(24) + 'SNAPPED TO'.padEnd(30) + 'HOW'.padEnd(10) + 'KCAL model→logged');
console.log('-'.repeat(92));

let wrong = 0;
for (const item of modelItems) {
  const hit = matchFood(foods, item.name);
  if (!hit) {
    console.log(item.name.padEnd(24) + '(kept model values)'.padEnd(30) + '—'.padEnd(10) + item.calories + ' → ' + item.calories);
    continue;
  }
  const how = hit.score >= 1000 ? 'exact' : hit.score >= 500 ? 'substring' : 'reverse';
  const logged = Math.round(hit.food.calories * (item.grams / 100));
  const drift = Math.round(((logged - item.calories) / item.calories) * 100);
  if (Math.abs(drift) > 12) wrong++;
  console.log(
    item.name.padEnd(24) +
    hit.food.name.padEnd(30) +
    how.padEnd(10) +
    `${item.calories} → ${logged}  (${drift > 0 ? '+' : ''}${drift}%)`
  );
}
console.log('-'.repeat(92));
console.log(`${wrong} of ${modelItems.length} logged with materially wrong calories (>12% drift)`);
