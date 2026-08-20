# Food matching: the library is overwriting the model

Diagnosed 2026-08-18, from `170 g of tuna and italian rice` logging as
*"white rice with tuna"*.

---

## The short answer

**It is adapting your food to the library, not logging what you ate.**

The vision model is doing the right thing. The prompt in
`buildSinglePhotoPrompt` never sends it the food library at all — it asks it to
inventory every visible component and return its own gram and macro estimates for
*that specific dish*. Those estimates come back correct.

They are then thrown away.

## Where

`shared/analysis-core.ts`, `normalizeItem` (line 244):

```js
const matched = matchFood(foods, item.name ?? "");
// ...
if (matched) return calculate(matched, grams, confidence, evidence);
```

`calculate()` rebuilds the item from the **library row's** per-100 g macros. Every
number the model produced — calories, protein, carbs, fibre, fat — is discarded
the moment a library entry is matched.

And `matchFood` matches on **substring**:

```js
if (target === alias) score = 1000 + alias.length;
else if (target.includes(alias)) score = 500 + alias.length;   // ← this
```

So any dish whose name *contains* a library food's name is replaced by that food.
`"italian rice"` contains `"rice"`. `"arroz italiano"` contains `"arroz"`.

Worse: the score rewards the **longer** alias, so a modifier can beat the actual
ingredient. `"tuna in olive oil"` scores 504 for `"tuna"` and **509 for
`"olive oil"`** — 170 g of tuna logs as 170 g of olive oil.

## How often

Twenty-six realistic Argentine dishes run through the real matcher against your
real 45-food library:

```
arroz italiano                  → White rice, cooked        substring "arroz"
arroz con pollo                 → Chicken breast, cooked    substring "pollo"
atun en aceite de oliva         → Olive oil                 substring "aceite de oliva"
pan con aceite de oliva         → Olive oil                 substring "aceite de oliva"
banana bread                    → Banana                    substring "banana"
budin de banana                 → Banana                    substring "banana"
sweet potato fries              → Sweet potato, cooked      substring "sweet potato"
pollo al curry                  → Chicken breast, cooked    substring "pollo"
tarta de manzana                → Apple                     substring "manzana"
yogur con granola               → Greek yogurt, nonfat      substring "yogur"
huevos revueltos con queso      → Whole egg                 substring "huevos"
tostada con palta               → Whole wheat bread         substring "tostada"
...
24 of 26 dishes overwritten by a substring match
```

Calorie impact on a sample:

| Model said | Logged as | Calories |
|---|---|---|
| Tuna in olive oil | Olive oil | 316 → **1,503** (+376%) |
| Banana bread | Banana | 330 → **89** (−73%) |
| Sweet potato fries | Sweet potato | 330 → **135** (−59%) |
| Chicken curry | Chicken breast | 420 → **495** (+18%) |

Your tuna-and-rice case is the mild version: tuna matched
`Tuna in water, drained` and the rice matched `White rice, cooked`. The calorie
total came out plausible, which is why it looked "kind of ok" — but the fat from
the rice preparation is gone, and if the tuna was oil-packed its fat is gone too.

Reproduce with `tools/match-audit.js`.

## Why the aliases are the wrong thing to fix

Tempting, since `"pollo"` and `"arroz"` are obvious magnets. Two reasons not to:

1. **Several magnets are the food's own name, not an alias.** `matchFood` builds
   its candidate list as `[food.name, ...aliases]`, so `"olive oil"`, `"banana"`,
   `"apple"` and `"dulce de leche"` collide no matter what the alias column says.
   Alias surgery fixes maybe two-thirds of cases.
2. **It would break the rules fallback.** `analyzeDescription` — the no-LLM path —
   has nothing *but* the library, so it genuinely needs loose matching. Removing
   `"pollo"` would stop Spanish descriptions matching chicken at all there.

The aliases are fine. The substitution rule is what is wrong.

## The fix

Let the library override the model only when it is unambiguously the **same
food**, not merely a food whose name appears inside this one.

### 1. Return the score from `matchFood`

```diff
 function matchFood(foods, name) {
   const target = clean(name);
   let best;
   for (const food of foods) {
     const aliases = [food.name, ...JSON.parse(food.aliases)].map(clean);
     for (const alias of aliases) {
       let score = 0;
       if (target === alias) score = 1000 + alias.length;
       else if (target.includes(alias)) score = 500 + alias.length;
       else if (alias.includes(target) && target.length >= 4) score = 100 + target.length;
       if (score > (best?.score ?? 0)) best = { food, score };
     }
   }
-  return best?.food;
+  return best;                     // { food, score } | undefined
 }
```

Update the two call sites in `analyzeDescription` to `matchFood(...)?.food` —
that path keeps its loose behaviour deliberately.

### 2. Only substitute on an exact match

In `normalizeItem`:

```diff
-  const matched = matchFood(foods, item.name ?? "");
+  const matched = matchFood(foods, item.name ?? "");
+
+  // The model returns per-dish macros for what it actually saw. Only let a
+  // library row overwrite them when the name matches EXACTLY — an exact hit
+  // means the model named a canonical ingredient ("banana", "arroz") and the
+  // curated row is better than an estimate. A substring hit means the model
+  // named something else that merely contains a library food ("banana bread"),
+  // and overwriting there is what produced 24/26 wrong logs.
+  const isSameFood = matched && matched.score >= 1000;
+
+  // If the model gave us nothing usable, a loose library match still beats zeros.
+  const modelHasMacros =
+    Number(item.calories ?? 0) > 0 || Number(item.protein ?? 0) > 0 ||
+    Number(item.carbs ?? 0) > 0 || Number(item.fat ?? 0) > 0;
+
   const evidence = { /* unchanged */ };
-  if (matched) return calculate(matched, grams, confidence, evidence);
+  if (isSameFood || (matched && !modelHasMacros)) {
+    return calculate(matched.food, grams, confidence, evidence);
+  }
```

Everything below that line — the `foodId: null` path with its
protein/carbs/fat/calorie sanity check — already exists and is exactly the
behaviour you want. It just was not being reached.

### What changes in practice

| Model returns | Before | After |
|---|---|---|
| `banana` | Banana row | Banana row *(unchanged — exact)* |
| `arroz` | White rice row | White rice row *(unchanged — exact)* |
| `banana bread` | Banana row | **model's macros**, `food_id: null` |
| `arroz italiano` | White rice row | **model's macros** |
| `tuna in olive oil` | Olive oil row | **model's macros** |

Canonical single ingredients keep their curated values and their `food_id` link.
Composite dishes keep the model's estimate. That is what "personalised" means
here.

## Trade-off worth knowing

After this, composite dishes carry `food_id: null`. They are still logged with
full macros and still counted everywhere, but they will not link to a library
row, so `foodsEaten` in the weekly report groups them by name string instead.
That is correct — "banana bread" genuinely is not "banana" — but it means the
library stops accumulating coverage of your real diet.

The follow-on, once this is in: let a logged composite be **saved to the library**
from the meal review screen. Log "arroz italiano" once, correct the grams, save it
as a food, and every later match is exact and curated. That is how the library
should have grown in the first place — from what you actually eat, rather than 41
seeded guesses.

## Verify

```bash
node tools/match-audit.js     # dish-level: which dishes get hijacked
node tools/match-test.js      # calorie drift on a sample
```

Both read the live library straight from D1, so re-run them after any change.
Target after the fix: only exact-name dishes report a library substitution.
