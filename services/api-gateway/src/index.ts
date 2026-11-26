import { bootstrapGatewayConfig } from './config/env';

async function main() {
  // Load and validate environment configuration before importing DB/Redis/HTTP modules
  const config = bootstrapGatewayConfig();
  const { startGatewayServer } = await import('./app.js');
  startGatewayServer(config);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : 'Unknown startup configuration failure.';
  console.error(`[StreetVerse Gateway] Fatal startup error: ${message}`);
  process.exit(1);
});
