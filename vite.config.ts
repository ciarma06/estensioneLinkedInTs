import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production';
  const manifestForBuild = structuredClone(manifest);

  if (isProduction) {
    manifestForBuild.host_permissions = (manifestForBuild.host_permissions ?? []).filter(
      (permission) => permission !== 'http://localhost:5173/*'
    );
    manifestForBuild.content_security_policy.extension_pages =
      manifestForBuild.content_security_policy.extension_pages.replace(' http://localhost:5173', '');
  }

  return {
    // Percorsi relativi negli HTML dell'estensione (evita script/CSS che non caricano in chrome-extension://)
    base: './',
    plugins: [crx({ manifest: manifestForBuild })],
    build: {
      rollupOptions: {
        output: {
          // Un solo chunk per il content script: evita un secondo file JS importato
          // dal chunk principale (spesso non caricato → script che non parte).
          manualChunks(id) {
            // Supabase in chunk dedicato: altrimenti il sidepanel importa lo stesso file del content script
            // (index.ts-*.js) e Rollup esegue tutto il modulo, incluso injectFloatingCRMButton().
            if (id.includes('node_modules/@supabase/') || id.includes('moduli/supabase')) {
              return 'vendor-supabase';
            }
            // Condiviso tra crm (sidepanel) e messageGenerator (content): se resta nel chunk content,
            // il sidepanel importa index.ts del content script ed esegue injectFloatingCRMButton.
            if (id.includes('moduli/userSettings')) {
              return 'vendor-user-settings';
            }
            // Stesso chunk del content script: floatingButton non deve finire nel bundle del sidepanel.
            if (
              id.includes('src/content/') ||
              id.includes('floatingButton') ||
              id.includes('content-floating-crm.css')
            ) {
              return 'content-entry';
            }
          },
        },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      hmr: {
        port: 5173,
      },
    },
  };
});