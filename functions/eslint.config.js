const {
    defineConfig,
    globalIgnores,
} = require("eslint/config");

const globals = require("globals");

const {
    fixupConfigRules,
    fixupPluginRules,
} = require("@eslint/compat");

const tsParser = require("@typescript-eslint/parser");
const typescriptEslint = require("@typescript-eslint/eslint-plugin");
const _import = require("eslint-plugin-import");
const js = require("@eslint/js");

const {
    FlatCompat,
} = require("@eslint/eslintrc");

const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

module.exports = defineConfig([{
    languageOptions: {
        globals: {
            ...globals.node,
        },

        parser: tsParser,
        sourceType: "module",

        parserOptions: {
            project: ["tsconfig.json", "tsconfig.dev.json"],
        },
    },

    extends: fixupConfigRules(compat.extends(
        "eslint:recommended",
        "plugin:import/errors",
        "plugin:import/warnings",
        "plugin:import/typescript",
        "plugin:@typescript-eslint/recommended",
    )),

    plugins: {
        "@typescript-eslint": fixupPluginRules(typescriptEslint),
        import: fixupPluginRules(_import),
    },

    rules: {
        "import/no-unresolved": 0,
        "indent": ["warn", 4, { "SwitchCase": 1 }],
        "no-unused-vars": "off",
        "@typescript-eslint/no-unused-vars": "warn",
    },
}, globalIgnores(["lib/**/*", "generated/**/*", "eslint.config.js"])]);
