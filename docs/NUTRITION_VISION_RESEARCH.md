# Nutrition vision research and benchmark design

Updated: 2026-08-13

## Practical conclusion

For this local web MVP, the strongest measurable baseline is:

1. Capture one clear RGB meal image and optional user context.
2. Ask a vision-language model to decompose the plate into ingredients, edible grams, oil, cooking method, and uncertainties.
3. Show the image and structured decomposition again in a second request that calculates calories and macros.
4. Let the user correct the result and store only repeatable preparation facts as personal memory.
5. Benchmark model/prompt changes on weighed meals using MAE and PMAE.

Segmentation and depth should be tested as independent variables. Neither replaces ingredient recognition or weighed ground truth.

## Images and labels used in the main papers

### Nutrition5k (CVPR 2021)

The official dataset contains 5,006 realistic cafeteria plates. Each plate may include:

- Four rotating side-angle videos captured by Raspberry Pi cameras at alternating 30- and 60-degree elevations.
- A directly overhead RGB image from an Intel RealSense D435.
- Raw and colorized overhead depth for roughly 3,500 dishes.
- A fine-grained ingredient list, each ingredient's measured mass, total dish mass, calories, fat, carbohydrates, and protein.
- Incremental plate scans with scale measurements accurate to approximately one gram.

The published 2D models sampled every fifth frame from the side videos. Images were resized and center-cropped to 256 x 256. RGB-D experiments used the overhead RealSense image and depth map. Raw depth uses 10,000 units per meter and is clipped at 0.4 m in the released dataset.

The collection contains more than 250 ingredients, about 5.7 ingredients per plate on average, and is biased toward food served in a small number of California cafeterias. It is not a culturally complete food benchmark.

Official dataset and license: [google-research-datasets/Nutrition5k](https://github.com/google-research-datasets/Nutrition5k) (CC BY 4.0).

### Nutrition320 and Gindee121 (CVPR Workshops 2025)

The two-step MLLM paper sampled 320 Nutrition5k images while preserving the calorie distribution, then also tested 121 real-world application images annotated by nutritionists. It compared:

- The original RGB image.
- Food-level and ingredient-level bounding boxes.
- SAM 2.1 masks, including box-prompted variants.
- FoodSAM semantic and panoptic segmentations.
- The proposed raw-image two-step prompt.

For visual-prompt experiments, the transformed image was paired with the original so the model retained scene context.

## Models and configurations reported

### Nutrition5k supervised baselines

- Backbone: InceptionV2, pretrained on JFT-300M.
- Input: 256 x 256 crop.
- Optimizer: RMSProp, initial learning rate 1e-4, momentum 0.9, decay 0.9, epsilon 1.0.
- Multi-task heads predicted calories, mass, protein, carbohydrates, and fat.
- Depth was tested as a fourth input channel.
- A separate volume experiment used depth-derived food volume as a mass-estimation prior.

Published test errors:

| Method | Calorie MAE | Aggregate macro error |
|---|---:|---:|
| RGB direct prediction | 70.6 kcal / 26.1% | 31.9% |
| Depth as fourth channel | 47.6 kcal / 18.8% | 20.9% |
| Volume-assisted pipeline | 41.3 kcal / 16.5% | 26.2% |

The portion-independent per-gram model was much more accurate, but it assumes the food mass is already known. That distinction matters: recognizing nutrient density is easier than estimating how much food is present.

### Two-step multimodal LLM study

Models:

- GPT-4o (2024-11-20)
- Gemini 2.0 Flash
- Qwen2.5-VL-72B
- Llama 3.2 90B Vision
- Additional reasoning-model comparisons with o1 and Gemini 2.0 Flash Thinking

Reported inference configuration: temperature 0.5, maximum 1,024 output tokens. The segmentation configuration used `facebook/sam2.1-hiera-large`, with automatic-mask generation and FoodSAM/YOLO-World variants.

On the full Nutrition5k evaluation reported by that paper, GPT-4o calorie MAE improved from 88.86 kcal with the direct prompt to 80.32 kcal with two-step prompting. Gemini 2.0 Flash improved from 126.03 to 102.93 kcal. Qwen2.5-VL did not improve on calories, which is why this must be benchmarked per model rather than assumed.

Primary paper: [Decomposing Food Images for Better Nutrition Analysis](https://openaccess.thecvf.com/content/CVPR2025W/MTF/html/Khlaisamniang_Decomposing_Food_Images_for_Better_Nutrition_Analysis_A_Nutritionist-Inspired_Two-Step_CVPRW_2025_paper.html).

## Prompt structures used in the research

The following are concise reproductions of the published structures, not verbatim copies.

### Direct baseline

Analyze all food in the image and return one JSON object. Describe the dish, identify all visible food names, estimate total weight, calories, protein, fat, carbohydrates, and major ingredients. Use reliable nutrient references such as USDA FoodData Central and make totals match ingredient proportions.

### Two-step: food analysis

Return structured food details before calculating nutrition:

- Major ingredients and portion grams.
- Standard serving weight consistent with the component list.
- Edible percentage after bones, peel, packaging, or garnish.
- Oil absorbed by fried or stir-fried food.
- Cooking methods.
- Dish name and visible uncertainty.

### Two-step: nutrition calculation

Given the structured food details and the image again:

- Sum ingredient-level calories.
- Sum significant protein sources.
- Include all fat sources and absorbed cooking oil.
- Sum carbohydrate contributions, especially grains and vegetables.
- Return one strict JSON object for the overall meal.

The Macroflow benchmark implements these concepts with stricter schemas and neutral wording. It does not reveal Nutrition5k IDs, ingredient labels, or ground truth to the model.

## Why contextual prompts matter

A separate GPT-4V dietary-assessment study used meal images from Ghanaian and Kenyan eating episodes, including before/after images and nearby utensils as scale references. Adding cuisine/origin context improved food-detection accuracy from 71.9% to 87.5%. Portion-size MAE was 54.6 g for GPT-4V versus 43.6 g for human visual estimates. The paper also reports difficulty with foods below 30 g.

This supports asking the user for cooking method, cuisine, oil, and a familiar plate/container. It does not justify silently guessing those details.

Primary paper: [Dietary Assessment with Multimodal ChatGPT](https://arxiv.org/abs/2312.08592).

## Where SAM 3 belongs

SAM 3 accepts short noun concepts, image exemplars, and visual point/box/mask prompts. It returns detections, masks, and tracked identities. It does not estimate edible mass, ingredients hidden inside food, oil, or nutrient density.

A sensible later experiment is:

`vision model food concepts -> SAM 3 masks -> RGB + masks + component list -> portion/nutrition model`

Run it against the raw two-step baseline. The 2025 food study shows that segmentation is not automatically better; masking can remove scale and preparation context. SAM 3 is also not offered as a normal chat-completions model by OpenRouter, so it requires a separate hosted inference service or native/local runtime.

Primary source: [SAM 3: Segment Anything with Concepts](https://ai.meta.com/research/publications/sam-3-segment-anything-with-concepts/).

## Where iPhone LiDAR belongs

The iPhone 13 Pro can provide `sceneDepth` and `smoothedSceneDepth` through native ARKit. Apple exposes per-frame distance maps and confidence information on supported LiDAR devices. Ordinary Safari photo capture does not expose that ARKit depth stream to this local web app.

The benchmark's colorized Nutrition5k depth mode is therefore a go/no-go experiment: if depth materially improves accuracy across enough plates, build a small native iOS capture companion later. If it does not, avoid paying the native-development cost.

Primary sources: [ARKit sceneDepth](https://developer.apple.com/documentation/arkit/arconfiguration/framesemantics-swift.struct/scenedepth), [Apple point-cloud sample](https://developer.apple.com/documentation/arkit/displaying-a-point-cloud-using-scene-depth).

## Macroflow pilot benchmark: 2026-08-13

Macroflow ran five current OpenRouter vision models against the same three official weighed Nutrition5k plates. Each model received one RGB image per plate using both the direct and two-step prompts. Temperature was 0.5, outputs used a strict JSON schema, and models with mandatory reasoning were set to minimum effort with additional token headroom so reasoning could not consume the 1,024-token answer budget.

| Model | Pipeline | Calorie MAE | Calorie PMAE | Macro MAE | Cost / valid plate | Latency / plate |
|---|---|---:|---:|---:|---:|---:|
| Gemini 3.6 Flash | One-step RGB | **59.3 kcal** | **17.0%** | **5.8 g** | $0.00117 | **2.6 s** |
| Gemini 3.6 Flash | Two-step RGB | 94.7 kcal | 27.2% | 7.5 g | $0.00304 | 6.3 s |
| Gemini 3.1 Flash Lite | One-step RGB | 126.6 kcal | 36.3% | 8.4 g | $0.00054 | 3.3 s |
| Qwen 3.8 Max | One-step RGB | 136.1 kcal | 39.1% | 8.8 g | $0.00752 | 21.7 s |
| Gemini 3.1 Flash Lite | Two-step RGB | 150.1 kcal | 43.1% | 8.4 g | $0.00144 | 6.3 s |
| Qwen 3.8 Max | Two-step RGB | 160.6 kcal | 46.1% | 11.2 g | $0.01764 | 52.4 s |
| Qwen 3.7 Plus | One-step RGB | 169.3 kcal | 48.6% | 13.1 g | $0.00048 | 13.3 s |
| Gemma 4 31B IT | Two-step RGB | 178.4 kcal | 51.2% | 12.5 g | $0.00022 | 24.5 s |
| Gemma 4 31B IT | One-step RGB | 253.9 kcal | 72.9% | 13.6 g | **$0.00009** | 26.1 s |
| Qwen 3.7 Plus | Two-step RGB | 328.6 kcal | 94.3% | 21.6 g | $0.00129 | 14.2 s |

The recorded cost of the 30 valid plate/configuration results was $0.1003. Failed attempts are not included in that number. Qwen 3.7 Plus returned schema-valid results on only 3 of 6 first attempts; the other models completed 6 of 6. The three missing Qwen results were retried until valid so the accuracy table stayed balanced.

On this smoke test, Gemini 3.6 Flash with the one-step prompt had the best calorie and macro accuracy and was also fastest. Two-step prompting improved only Gemma's calorie result; it hurt the other four models. This mirrors the paper's model-dependent finding and is evidence against assuming that a longer pipeline is automatically better. The sample is far too small to call any model universally best.

### Photo-only depth ablation

The three bundled RGB images were processed on CPU with `depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf`, then compared pixel-wise with the official raw RealSense depth maps. Inference averaged 0.75 seconds per image.

- Uncalibrated metric-depth MAE: 0.579 m.
- Mean absolute-relative depth error: 1.525.
- Median predicted scene distance: approximately 0.96 m.
- Median RealSense distance: approximately 0.38 m.
- After per-image median-scale alignment, depth MAE fell to 0.0173 m.

The model therefore recovered useful relative structure but failed at absolute scale. This supports using a known plate diameter as a scale anchor rather than treating photo-predicted meters as measurements.

Gemini 3.6 Flash was then run three times on each plate for every direct-prompt depth condition:

| Input | Trials | Calorie MAE | Macro MAE | Cost / plate |
|---|---:|---:|---:|---:|
| RGB only | 9 | **51.3 kcal** | **5.6 g** | **$0.00120** |
| RGB + photo-predicted depth visualization | 9 | 53.9 kcal | 6.2 g | $0.00214 |
| RGB + RealSense sensor-depth visualization | 9 | 67.0 kcal | 6.7 g | $0.00213 |

The two-step variants were also negative: RGB scored 94.7 kcal MAE, RGB plus sensor depth 116.9, and RGB plus predicted depth 141.4. A depth heatmap shown to the VLM is therefore not a substitute for numerical geometry. The next defensible experiment is `mask + calibrated depth + numerical volume`, not another prompt variation. SAM 3 was not tested because no hosted-SAM credential is configured and the official runtime requires a CUDA GPU unavailable on this machine.

## Evaluation protocol

Use the official test cases without showing their labels to the model.

1. Run each model/strategy at least three times because the research configuration uses temperature 0.5.
2. Compare the same cases across configurations.
3. Report MAE for calories, mass, protein, carbs, and fat.
4. Report PMAE as `sum(abs(prediction - truth)) / sum(truth) * 100` for each nutrient.
5. Keep per-case absolute error visible, but do not rank with per-case percentage error alone; small ground-truth values make it unstable.
6. Separate identification failures, portion failures, and nutrient-density failures during review.
7. Expand from three smoke-test dishes to at least 30 varied dishes before selecting a production model; use 100+ before making a strong accuracy claim.

The three bundled samples are smoke tests, not a statistically meaningful result.

### Production one-photo pipeline test

The personal-app pipeline was narrowed to exactly one RGB photograph and a known 25 cm flat round plate. The prompt applies the plate only when its complete circular rim is visible, decomposes the meal before estimating portions, returns low/high gram ranges, checks macro-derived calories, applies only matching personal memories, and asks one high-impact correction question. It uses one OpenRouter call and no SAM or predicted-depth service.

On the same three weighed plates, Gemini 3.6 Flash with low reasoning produced:

| Pipeline | Calorie MAE | Mass MAE | Macro MAE | Range coverage | Cost / plate | Latency |
|---|---:|---:|---:|---:|---:|---:|
| One photo + conditional 25 cm plate | **43.1 kcal** | **30.3 g** | **4.8 g** | 2/3 | **$0.00471** | **6.7 s** |
| One photo, scale disabled (minimal-reasoning ablation) | 56.7 kcal | 47.3 g | 5.5 g | 3/3 | $0.00344 | 5.4 s |

The reasoning levels differ, so this is not a clean plate-only ablation. A separate matched minimal-reasoning pair scored 49.1 kcal / 30.7 g / 4.5 g with the plate and 56.7 kcal / 47.3 g / 5.5 g without it. That paired smoke test supports using the known plate while also showing that range calibration still needs more cases. The square-plate case was correctly rejected as not matching the personal circular plate profile.

Detailed outputs are in `tmp/single-photo-v2-*.json`. Expand to at least 30 varied weighed personal meals before changing the production model or making an accuracy claim.

## Primary sources

- [Nutrition5k paper, CVPR 2021](https://openaccess.thecvf.com/content/CVPR2021/html/Thames_Nutrition5k_Towards_Automatic_Nutritional_Understanding_of_Generic_Food_CVPR_2021_paper.html)
- [Nutrition5k official dataset](https://github.com/google-research-datasets/Nutrition5k)
- [Two-step MLLM nutrition paper, CVPR Workshops 2025](https://openaccess.thecvf.com/content/CVPR2025W/MTF/html/Khlaisamniang_Decomposing_Food_Images_for_Better_Nutrition_Analysis_A_Nutritionist-Inspired_Two-Step_CVPRW_2025_paper.html)
- [Dietary Assessment with Multimodal ChatGPT](https://arxiv.org/abs/2312.08592)
- [SAM 3 primary research page](https://ai.meta.com/research/publications/sam-3-segment-anything-with-concepts/)
- [OpenRouter image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding)
- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [OpenRouter model discovery API](https://openrouter.ai/docs/api/api-reference/models/get-models)
