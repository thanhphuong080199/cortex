import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    ignores: ["**/dist/**", "**/.next/**", "**/.expo/**", "**/node_modules/**"],
  },
  {
    rules: {
      // ignoreRestSiblings covers `const { omitted: _x, ...rest } = obj` -- the standard
      // way to drop a key -- without opening a blanket `_`-prefixed escape hatch for
      // genuinely dead variables, which varsIgnorePattern would.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ]
    }
  }
);
