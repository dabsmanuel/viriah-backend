import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Rules are chosen to catch real bugs. The codebase types its models loosely on purpose (see core/tenancy.ts), so `any` is allowed.
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "storage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
    },
  },
);
