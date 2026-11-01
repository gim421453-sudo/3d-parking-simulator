import { defineConfig } from 'vitest/config';

// base './' : GitHub Pages(하위 경로)와 Capacitor(file/https://localhost) 양쪽에서 상대 경로로 리소스를 불러온다.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
