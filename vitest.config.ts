import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'happy-dom',
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
        passWithNoTests: true,
        restoreMocks: true,
    },
});
