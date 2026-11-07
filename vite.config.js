import { defineConfig } from 'vite';

// "./" makes every asset path in the built site relative to index.html.
// That means the site works from any GitHub Pages project URL
// (https://USERNAME.github.io/REPOSITORY/) without hardcoding a repository name.
//
// If you ever need an absolute base path (for example a custom setup), build with:
//   VITE_BASE_PATH=/your-repository-name/ npm run build
export default defineConfig({
  base: process.env.VITE_BASE_PATH || './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1000,
  },
});
