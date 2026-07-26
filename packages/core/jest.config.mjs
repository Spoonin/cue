/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // swc, not ts-jest: ts-jest 29 peers on `typescript >=4.3 <6` and this package
  // is on 7. swc transpiles without consulting the TypeScript compiler, so the
  // compiler version stops mattering. Type checking is `pnpm typecheck`, not jest.
  transform: {
    '^.+\\.tsx?$': ['@swc/jest', {
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript' },
      },
    }],
  },
};
