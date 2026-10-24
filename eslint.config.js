// Configuration ESLint (format « flat config »). Lancer : npx eslint .
export default [
  {
    ignores: ['node_modules/**'],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', queueMicrotask: 'readonly',
        performance: 'readonly', structuredClone: 'readonly', fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        AbortController: 'readonly', Blob: 'readonly', FileReader: 'readonly', Audio: 'readonly', Node: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', atob: 'readonly', btoa: 'readonly', MediaRecorder: 'readonly', ResizeObserver: 'readonly',
        sessionStorage: 'readonly', BroadcastChannel: 'readonly', Buffer: 'readonly',
        getComputedStyle: 'readonly', getSelection: 'readonly', globalThis: 'readonly', self: 'readonly', caches: 'readonly',
        history: 'readonly', Request: 'readonly', Response: 'readonly', process: 'readonly', crypto: 'readonly', MessageChannel: 'readonly', MutationObserver: 'readonly', Image: 'readonly', setImmediate: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-imports': 'error',
      'no-redeclare': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
];
