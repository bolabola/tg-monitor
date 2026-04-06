import { startMonitor, stopMonitor } from './src/monitor.js';

const shutdown = async (signal) => {
    console.log(`\n${signal} received, shutting down...`);
    await stopMonitor();
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', async (err) => {
    console.error('uncaught exception:', err);
    await stopMonitor();
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('unhandled promise rejection:', reason);
});

process.on('warning', (warning) => {
    console.warn(`${warning.name}: ${warning.message}`);
    if (warning.stack) {
        console.warn(warning.stack);
    }
});

startMonitor().catch(err => {
    console.error('startup failed:', err);
    process.exit(1);
});
