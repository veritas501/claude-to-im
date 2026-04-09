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

await build({
  entrypoints: ['src/mcp-server.ts'],
  compile: {
    outfile: 'mcp-server',
  },
  target: 'bun',
  external: [
    'bufferutil',
    'utf-8-validate',
  ],
  production: true,
});

console.log('Built mcp-server (ELF)');
