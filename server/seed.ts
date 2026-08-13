export type SeedFood = {
  name: string;
  brand?: string;
  category: string;
  emoji: string;
  servingLabel: string;
  servingGrams: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  aliases: string[];
};

export const seedFoods: SeedFood[] = [
  { name: "Chicken breast, cooked", category: "Protein", emoji: "🍗", servingLabel: "1 breast", servingGrams: 170, calories: 165, protein: 31, carbs: 0, fat: 3.6, aliases: ["chicken", "chicken breast", "pollo", "pechuga", "pechuga de pollo"] },
  { name: "Chicken thigh, cooked", category: "Protein", emoji: "🍗", servingLabel: "1 thigh", servingGrams: 110, calories: 209, protein: 26, carbs: 0, fat: 10.9, aliases: ["chicken thigh", "muslo", "muslo de pollo"] },
  { name: "Lean beef steak", category: "Protein", emoji: "🥩", servingLabel: "1 steak", servingGrams: 180, calories: 217, protein: 26.1, carbs: 0, fat: 11.8, aliases: ["steak", "beef", "carne", "bife", "asado"] },
  { name: "Ground beef, 90% lean", category: "Protein", emoji: "🥩", servingLabel: "1 portion", servingGrams: 150, calories: 217, protein: 26.1, carbs: 0, fat: 11.8, aliases: ["ground beef", "minced beef", "carne picada", "hamburger"] },
  { name: "Salmon, cooked", category: "Protein", emoji: "🐟", servingLabel: "1 fillet", servingGrams: 160, calories: 206, protein: 22.1, carbs: 0, fat: 12.4, aliases: ["salmon", "salmón"] },
  { name: "Tuna in water, drained", category: "Protein", emoji: "🐟", servingLabel: "1 can", servingGrams: 120, calories: 116, protein: 25.5, carbs: 0, fat: 0.8, aliases: ["tuna", "atun", "atún"] },
  { name: "Whole egg", category: "Protein", emoji: "🥚", servingLabel: "1 large egg", servingGrams: 50, calories: 143, protein: 12.6, carbs: 0.7, fat: 9.5, aliases: ["egg", "eggs", "huevo", "huevos"] },
  { name: "Egg whites", category: "Protein", emoji: "🥚", servingLabel: "3 egg whites", servingGrams: 100, calories: 52, protein: 10.9, carbs: 0.7, fat: 0.2, aliases: ["egg white", "egg whites", "claras", "clara de huevo"] },
  { name: "White rice, cooked", category: "Carbs", emoji: "🍚", servingLabel: "1 cup", servingGrams: 158, calories: 130, protein: 2.7, carbs: 28.2, fat: 0.3, aliases: ["rice", "white rice", "arroz", "arroz blanco"] },
  { name: "Brown rice, cooked", category: "Carbs", emoji: "🍚", servingLabel: "1 cup", servingGrams: 195, calories: 123, protein: 2.7, carbs: 25.6, fat: 1, aliases: ["brown rice", "arroz integral"] },
  { name: "Pasta, cooked", category: "Carbs", emoji: "🍝", servingLabel: "1 cup", servingGrams: 140, calories: 157, protein: 5.8, carbs: 30.9, fat: 0.9, aliases: ["pasta", "spaghetti", "noodles", "fideos", "tallarines"] },
  { name: "Rolled oats, cooked", category: "Carbs", emoji: "🥣", servingLabel: "1 bowl", servingGrams: 234, calories: 71, protein: 2.5, carbs: 12, fat: 1.5, aliases: ["oats", "oatmeal", "avena"] },
  { name: "Potato, baked", category: "Carbs", emoji: "🥔", servingLabel: "1 medium", servingGrams: 173, calories: 93, protein: 2.5, carbs: 21.2, fat: 0.1, aliases: ["potato", "potatoes", "papa", "papas"] },
  { name: "Mashed potatoes", category: "Carbs", emoji: "🥔", servingLabel: "1 cup", servingGrams: 210, calories: 113, protein: 2, carbs: 16.8, fat: 4.2, aliases: ["mashed potato", "mashed potatoes", "pure", "puré", "pure de papa"] },
  { name: "Sweet potato, cooked", category: "Carbs", emoji: "🍠", servingLabel: "1 medium", servingGrams: 150, calories: 90, protein: 2, carbs: 20.7, fat: 0.2, aliases: ["sweet potato", "batata", "boniato"] },
  { name: "Whole wheat bread", category: "Carbs", emoji: "🍞", servingLabel: "2 slices", servingGrams: 56, calories: 247, protein: 13, carbs: 41, fat: 3.4, aliases: ["bread", "toast", "whole wheat bread", "pan", "tostada"] },
  { name: "Flour tortilla", category: "Carbs", emoji: "🌯", servingLabel: "1 tortilla", servingGrams: 49, calories: 312, protein: 8.3, carbs: 52.1, fat: 8.3, aliases: ["tortilla", "wrap"] },
  { name: "Quinoa, cooked", category: "Carbs", emoji: "🌾", servingLabel: "1 cup", servingGrams: 185, calories: 120, protein: 4.4, carbs: 21.3, fat: 1.9, aliases: ["quinoa"] },
  { name: "Lentils, cooked", category: "Carbs", emoji: "🫘", servingLabel: "1 cup", servingGrams: 198, calories: 116, protein: 9, carbs: 20.1, fat: 0.4, aliases: ["lentils", "lentejas"] },
  { name: "Black beans, cooked", category: "Carbs", emoji: "🫘", servingLabel: "1 cup", servingGrams: 172, calories: 132, protein: 8.9, carbs: 23.7, fat: 0.5, aliases: ["black beans", "beans", "porotos", "frijoles"] },
  { name: "Chickpeas, cooked", category: "Carbs", emoji: "🫘", servingLabel: "1 cup", servingGrams: 164, calories: 164, protein: 8.9, carbs: 27.4, fat: 2.6, aliases: ["chickpeas", "garbanzos"] },
  { name: "Greek yogurt, nonfat", category: "Dairy", emoji: "🥛", servingLabel: "1 cup", servingGrams: 200, calories: 59, protein: 10.3, carbs: 3.6, fat: 0.4, aliases: ["greek yogurt", "yogurt", "yoghurt", "yogur griego", "yogur"] },
  { name: "Whole milk", category: "Dairy", emoji: "🥛", servingLabel: "1 cup", servingGrams: 244, calories: 61, protein: 3.2, carbs: 4.8, fat: 3.3, aliases: ["milk", "whole milk", "leche"] },
  { name: "Mozzarella cheese", category: "Dairy", emoji: "🧀", servingLabel: "1 slice", servingGrams: 28, calories: 280, protein: 28, carbs: 3.1, fat: 17, aliases: ["mozzarella", "cheese", "queso", "queso mozzarella"] },
  { name: "Avocado", category: "Fats", emoji: "🥑", servingLabel: "1/2 avocado", servingGrams: 100, calories: 160, protein: 2, carbs: 8.5, fat: 14.7, aliases: ["avocado", "palta"] },
  { name: "Olive oil", category: "Fats", emoji: "🫒", servingLabel: "1 tbsp", servingGrams: 14, calories: 884, protein: 0, carbs: 0, fat: 100, aliases: ["oil", "olive oil", "aceite", "aceite de oliva"] },
  { name: "Sunflower oil", category: "Fats", emoji: "🌻", servingLabel: "1 tbsp", servingGrams: 14, calories: 884, protein: 0, carbs: 0, fat: 100, aliases: ["sunflower oil", "aceite de girasol"] },
  { name: "Butter", category: "Fats", emoji: "🧈", servingLabel: "1 tbsp", servingGrams: 14, calories: 717, protein: 0.9, carbs: 0.1, fat: 81.1, aliases: ["butter", "manteca", "mantequilla"] },
  { name: "Peanut butter", category: "Fats", emoji: "🥜", servingLabel: "2 tbsp", servingGrams: 32, calories: 588, protein: 25, carbs: 20, fat: 50, aliases: ["peanut butter", "mantequilla de mani", "mantequilla de maní"] },
  { name: "Almonds", category: "Fats", emoji: "🌰", servingLabel: "1 handful", servingGrams: 28, calories: 579, protein: 21.2, carbs: 21.6, fat: 49.9, aliases: ["almonds", "almendras"] },
  { name: "Banana", category: "Fruit", emoji: "🍌", servingLabel: "1 medium", servingGrams: 118, calories: 89, protein: 1.1, carbs: 22.8, fat: 0.3, aliases: ["banana", "platano", "plátano"] },
  { name: "Apple", category: "Fruit", emoji: "🍎", servingLabel: "1 medium", servingGrams: 182, calories: 52, protein: 0.3, carbs: 13.8, fat: 0.2, aliases: ["apple", "manzana"] },
  { name: "Strawberries", category: "Fruit", emoji: "🍓", servingLabel: "1 cup", servingGrams: 152, calories: 32, protein: 0.7, carbs: 7.7, fat: 0.3, aliases: ["strawberry", "strawberries", "frutilla", "frutillas"] },
  { name: "Blueberries", category: "Fruit", emoji: "🫐", servingLabel: "1 cup", servingGrams: 148, calories: 57, protein: 0.7, carbs: 14.5, fat: 0.3, aliases: ["blueberry", "blueberries", "arandanos", "arándanos"] },
  { name: "Broccoli, cooked", category: "Vegetables", emoji: "🥦", servingLabel: "1 cup", servingGrams: 156, calories: 35, protein: 2.4, carbs: 7.2, fat: 0.4, aliases: ["broccoli", "brócoli"] },
  { name: "Mixed green salad", category: "Vegetables", emoji: "🥗", servingLabel: "1 bowl", servingGrams: 120, calories: 25, protein: 1.6, carbs: 4.5, fat: 0.3, aliases: ["salad", "green salad", "mixed salad", "ensalada", "ensalada verde"] },
  { name: "Tomato", category: "Vegetables", emoji: "🍅", servingLabel: "1 medium", servingGrams: 123, calories: 18, protein: 0.9, carbs: 3.9, fat: 0.2, aliases: ["tomato", "tomatoes", "tomate", "tomates"] },
  { name: "Whey protein powder", category: "Supplements", emoji: "🥤", servingLabel: "1 scoop", servingGrams: 30, calories: 400, protein: 80, carbs: 10, fat: 6.7, aliases: ["whey", "protein powder", "protein shake", "proteina", "proteína"] },
  { name: "Chicken milanesa", category: "Prepared", emoji: "🍗", servingLabel: "1 cutlet", servingGrams: 180, calories: 245, protein: 23, carbs: 14, fat: 10.5, aliases: ["milanesa", "chicken milanesa", "milanesa de pollo"] },
  { name: "Beef empanada, baked", category: "Prepared", emoji: "🥟", servingLabel: "1 empanada", servingGrams: 90, calories: 254, protein: 10.4, carbs: 26.5, fat: 11.8, aliases: ["empanada", "beef empanada", "empanada de carne"] },
  { name: "Dulce de leche", category: "Treats", emoji: "🍮", servingLabel: "1 tbsp", servingGrams: 20, calories: 315, protein: 6.8, carbs: 55, fat: 7.3, aliases: ["dulce de leche"] }
];
