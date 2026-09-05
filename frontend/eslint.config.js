import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';

export default tseslint.config(
  { ignores: [
    '*.cjs',
    'src/types/generated/**/*', // Auto-generated OpenAPI client - do not lint
  ] },
  {
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // eslint-plugin-react-hooks v7 added two stricter rules that
      // fire on patterns this codebase has been using without
      // issue: accessing a function declared after its useEffect
      // (TDZ, but the effect runs after render so the reference
      // is fine), and calling setState synchronously inside an
      // effect to seed derived state on mount. Both are real
      // smells in some contexts but a wholesale sweep of the
      // codebase to silence them would create more churn than
      // value. Disable until we have time to do the refactor.
      'react-hooks/immutability': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  }
);
