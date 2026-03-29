module.exports = {
    apps: [
        {
            name: 'tg-monitor',
            script: 'app.js',
            watch: false,
            max_memory_restart: '300M',
            restart_delay: 5000,
            max_restarts: 50,
            autorestart: true,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            env: {
                NODE_ENV: 'production'
            }
        }
    ]
};
