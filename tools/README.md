# tools

Diagnostics for the food-matching bug described in `../MATCHING-FIX.md`.

Both scripts run the **verbatim** `clean`/`matchFood` from
`recovered/shared/analysis-core.ts` against the **live** food library, so their
output reflects what production actually does.

Refresh the library snapshot first:

```bash
CLOUDFLARE_ACCOUNT_ID=6c3b2df3d669fda007025e023ffee12c npx wrangler d1 execute macroflow --remote --json --command "SELECT id,name,aliases,calories,protein,carbs,fiber,fat FROM foods;" > tools/foods.json
```

| Script | Answers |
|---|---|
| `match-audit.js` | Which dishes get hijacked, and which aliases are the magnets |
| `match-test.js` | Calorie drift when the library overwrites the model |

After the fix lands, only exact-name items should report a library substitution.
