-- 0005_fiber_foods.sql — foods the raised fibre target and the report food-rules depend on
--
-- Context: settings.fiber_target moved 30 g -> 43 g (14 g per 1000 kcal at a
-- 3110 kcal target, per macros.md §7). The existing 41-food library already
-- carries the bulk fibre sources (black beans 8.7, lentils 7.9, chickpeas 7.6,
-- whole wheat bread 7.0, almonds 12.5, avocado 6.7 per 100 g), so this adds only
-- the genuine gaps rather than padding the list.
--
-- Two of these exist because src/reports.ts names them in its system prompt and
-- tells the model to "prefer foods already in their library" — sardines are cited
-- for both the calcium and omega-3 food rules, and psyllium is the documented
-- fallback when raising fibre causes GI trouble. Neither was in `foods`, so the
-- model was being asked to recommend food the user could not then log.
--
-- CONVENTION: macro columns are per 100 g (see macroflow-kb.md §3).
-- serving_grams is the scaling factor, NOT the basis of these numbers.
--
-- INVARIANT: fiber <= carbs. shared/analysis-core.ts clamps with
-- Math.min(carbs, fiber), so a row violating this would be silently truncated
-- at analysis time. Every row below satisfies it.
--
-- Idempotent: `foods.name` is UNIQUE and this uses INSERT OR IGNORE, so applying
-- it after the rows already exist is a no-op.

INSERT OR IGNORE INTO foods
  (name, brand, category, emoji, serving_label, serving_grams,
   calories, protein, carbs, fiber, fat, aliases)
VALUES
  -- 34.4 g fibre per 100 g — the most fibre-dense item in the library by 3x.
  -- One 30 g serving is 10 g, roughly a quarter of the daily target on its own.
  ('Chia seeds', '', 'Fats', '🌱', '2 tbsp (30 g)', 30,
   486, 16.5, 42.1, 34.4, 30.7,
   '["chia","chia seeds","semillas de chia","semillas de chía"]'),

  -- Serves two food rules at once: oily fish for EPA+DHA, and edible bones for
  -- calcium. The library''s only other oily fish was salmon.
  ('Sardines, canned in oil, drained', '', 'Protein', '🐟', '1 tin (92 g)', 92,
   208, 24.6, 0, 0, 11.5,
   '["sardinas","sardinas en lata","sardines","sardina"]'),

  -- GI rescue, not a food: macros.md §7 names psyllium as the soluble-fibre
  -- fallback if ramping fibre causes diarrhoea. 10 g adds 8 g fibre for ~20 kcal.
  ('Psyllium husk', '', 'Supplements', '🥄', '1 tbsp (10 g)', 10,
   200, 0, 85, 80, 0.5,
   '["psyllium","psilio","cascara de psyllium","cáscara de psyllium","plantago ovata"]'),

  -- Highest-fibre fruit available; the four existing fruits top out at 2.6 g.
  ('Raspberries', '', 'Fruit', '🍇', '1 cup (123 g)', 123,
   52, 1.2, 11.9, 6.5, 0.7,
   '["frambuesas","frambuesa","raspberries"]');
