import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const WEB_SERVER = 'http://localhost:80';

export default defineConfig({
  plugins: [react()],
  // scbl-lib/config reads process.env, which Create React App defined in the browser. Defining it
  // as empty keeps the config's defaults, as before. Builds already do this, but the dev server
  // does not.
  define: {
    'process.env': {}
  },
  server: {
    port: 3000,
    // Send API requests to the web server. The trailing slashes keep client routes such as
    // /export-ban-lists from being proxied.
    proxy: {
      '/graphql': WEB_SERVER,
      '/auth/': WEB_SERVER,
      '/export/': WEB_SERVER
    }
  },
  build: {
    // The web server serves client/build and mounts client/build/static at /static.
    outDir: 'build',
    assetsDir: 'static'
  },
  css: {
    preprocessorOptions: {
      scss: {
        // The vendored Bootstrap 4 and Argon styles predate these Dart Sass deprecations, which
        // would otherwise print hundreds of warnings on every build.
        silenceDeprecations: [
          'color-functions',
          'function-units',
          'global-builtin',
          'if-function',
          'import',
          'slash-div'
        ]
      }
    }
  }
});
