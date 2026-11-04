import { defineConfig } from 'vitest/config';

// base: './' → GitHub Pages의 어떤 저장소 경로(/저장소이름/)에서도 동작하도록 상대 경로로 빌드
export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2020' },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
