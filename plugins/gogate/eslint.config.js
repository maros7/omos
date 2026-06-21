// eslint.config.js — ESLint flat config. TS type-checked rules via
// typescript-eslint. Lints src/ (index + resolve/rewrite/tokenize + tests).
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: ["coverage/**", "node_modules/**", "eslint.config.js"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Allow `_`-prefixed args/vars to mark intentionally unused parameters.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // No `as` casts — narrow with type guards instead.
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      // No `any` — use `unknown` + narrow.
      "@typescript-eslint/no-explicit-any": "error",
      // No `!` — narrow or throw.
      "@typescript-eslint/no-non-null-assertion": "error",
      // >3 params → object param.
      "max-params": ["error", 3],
      // Prefer `??` over `||`.
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      // Flag conditions / chains that the type system says are unnecessary.
      "@typescript-eslint/no-unnecessary-condition": "warn",
    },
  },
)
