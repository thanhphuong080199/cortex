import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    // `.vercel/output` is gitignored, so CI never sees it -- but `vercel deploy` run locally
    // leaves generated launchers behind that fail no-require-imports, turning a local lint red
    // for reasons no commit caused.
    ignores: ["**/dist/**", "**/.next/**", "**/.expo/**", "**/.vercel/**", "**/node_modules/**"],
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
