// eslint.config.js — ESLint flat config. TS type-checked rules via
// typescript-eslint. Lints src/ (config + index + tests). The ambient
// `bun-test.d.ts` shim is excluded — it's a type-declaration module shim, not
// lintable source (it declares a `bun:test` ambient module with `any`-typed
// helpers by design, since tripwire intentionally ships zero type-only deps).
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: [
      "coverage/**",
      "node_modules/**",
      "eslint.config.js",
      "src/bun-test.d.ts",
    ],
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
