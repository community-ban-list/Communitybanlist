import neostandard from 'neostandard';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  // Standard's rules without its style rules, since Prettier formats the code.
  ...neostandard({
    noStyle: true,
    ignores: ['client/build/**', 'client/src/assets/vendor/**']
  }),
  {
    files: ['client/src/**/*.{js,jsx}', 'client/public/**/*.js'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The two rules Create React App enforced. The plugin's newer recommended set adds React
      // Compiler rules, which this app does not use.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Handlers are often third-party props, such as react-step-wizard's nextStep, which this
      // naming rule would require renaming.
      'react/jsx-handler-names': 'off'
    }
  },
  prettier
];
