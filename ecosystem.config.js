module.exports = {
  apps: [
    {
      name      : 'klickpint',
      script    : 'server.js',

      // ── Cluster mode: use ALL CPU cores ───────────────────────────────
      // VPS ke saare cores use honge — 4 cores = 4x capacity
      //
      // CAVEAT: server.js keeps the rate limiter, the abuse tracker and the
      // pin cache in process memory, and cluster workers do NOT share memory.
      // With N workers the effective per-IP limits become N× looser (25/hour
      // becomes 25×N) and the cache hit rate drops, because a given IP is
      // load-balanced across workers. Set `instances: 1` if strict limits
      // matter more than throughput, or move that state into Redis
      // (rate-limit-redis) before scaling out.
      instances : 'max',       // auto-detect CPU count
      exec_mode : 'cluster',   // load balance across all cores

      watch             : false,
      max_memory_restart: '250M',   // per instance limit

      env: {
        NODE_ENV : 'development',
        PORT     : 3020,
      },
      env_production: {
        NODE_ENV : 'production',
        PORT     : 3020,
      },

      // Auto-restart
      autorestart   : true,
      restart_delay : 2000,
      max_restarts  : 15,

      // Graceful shutdown (finish in-flight requests before restart)
      kill_timeout  : 5000,
      wait_ready    : true,
      listen_timeout: 8000,

      // Logging
      log_date_format : 'YYYY-MM-DD HH:mm:ss',
      out_file        : '/var/log/klickpint/out.log',
      error_file      : '/var/log/klickpint/error.log',
      merge_logs      : true,
    }
  ]
};
