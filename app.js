import { startMonitor, stopMonitor } from './src/monitor.js';

const shutdown = async (signal) => {
    console.log(`\n${signal} received, shutting down...`);
    await stopMonitor();
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', async (err) => {
    console.error('❌ 未捕获异常:', err);
    await stopMonitor();
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ 未处理的 Promise 拒绝:', reason);
});

startMonitor().catch(err => {
    console.error('启动失败:', err);
    process.exit(1);
});
