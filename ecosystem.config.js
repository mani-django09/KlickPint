module.exports = {
  apps: [
    {
      name        : 'klickpint',
      script      : 'server.js',
      instances   : 1,           // increase to 'max' for multi-core
      exec_mode   : 'fork',
      watch       : false,
      max_memory_restart: '300M',

      env: {
        NODE_ENV : 'development',
        PORT     : 3020,
      },
      env_production: {
        NODE_ENV : 'production',
        PORT     : 3020,
      },

      // Auto-restart settings
      autorestart   : true,
      restart_delay : 3000,
      max_restarts  : 10,

      // Logging
      log_date_format : 'YYYY-MM-DD HH:mm:ss',
      out_file        : '/var/log/klickpint/out.log',
      error_file      : '/var/log/klickpint/error.log',
      merge_logs      : true,
    }
  ]
};
