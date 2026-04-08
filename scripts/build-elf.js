import { build } from 'bun';

await build({
  entrypoints: ['src/main.ts'],
  compile: {
    outfile: 'daemon',
  },
  target: 'bun',
  external: [
    'bufferutil',
    'utf-8-validate',
    'zlib-sync',
    'erlpack',
  ],
  production: true,
});

console.log('Built daemon (ELF)');
