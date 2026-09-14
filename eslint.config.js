import tseslint from "typescript-eslint";
import eslintPluginPrettier from "eslint-plugin-prettier";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default [
  { ignores: ["dist/", "node_modules/"] },
  ...tseslint.configs.recommended,
  // Run Prettier as a lint rule so `lint --fix` also formats.
  // eslint-plugin-prettier's preset uses the legacy `extends` key, which flat
  // config rejects, so expand it manually (eslint-config-prettier is already
  // included above and does the same job).
  {
    plugins: { prettier: eslintPluginPrettier },
    rules: {
      "prettier/prettier": "error",
      "arrow-body-style": "off",
      "prefer-arrow-callback": "off",
    },
  },
  // Disable rules that conflict with Prettier. Must come last so its rule
  // overrides win.
  eslintConfigPrettier,
];
