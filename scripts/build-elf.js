import { build } from 'bun';

await build({
  entrypoints: ['src/main.ts'],
  compile: {
    outfile: 'daemon',
  },
  target: 'bun',
  external: [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    'bufferutil',
    'utf-8-validate',
    'zlib-sync',
    'erlpack',
  ],
  production: true,
});

console.log('Built daemon (ELF)');
