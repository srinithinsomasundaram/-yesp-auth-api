module.exports = {
  apps: [
    {
      name: "yesp-auth-api",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      // Always-on env (safe defaults)
      env: {
        NODE_ENV: "production",
        PORT: 3100,
        API_PORT: 3100,
      },
      // Overrides when started with --env production
      env_production: {
        NODE_ENV: "production",
        PORT: 3100,
        API_PORT: 3100,
      },
      error_file: "./logs/api-error.log",
      out_file: "./logs/api-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      // Give the process up to 15 s to be considered "online"
      listen_timeout: 15000,
      // Wait 5 s for graceful shutdown before SIGKILL
      kill_timeout: 5000,
      // Restart on crash with backoff
      restart_delay: 3000,
      max_restarts: 10,
      // Don't restart on clean exit (exit code 0)
      autorestart: true,
      stop_exit_codes: [0],
    },
    {
      name: "yesp-accounts-console",
      script: "node_modules/.bin/next",
      // Use $PORT if Nimbuz/platform injects it, otherwise fall back to 3002
      args: `start -p ${process.env.PORT || 3002}`,
      cwd: `${__dirname}/console`,
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3002,
        BACKEND_URL: "http://localhost:3100",
        NEXT_PUBLIC_AUTH_URL: "https://auth.yesp.space",
        NEXT_PUBLIC_CONSOLE_URL: "https://accounts.yesp.space",
      },
      env_production: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3002,
        BACKEND_URL: "http://localhost:3100",
        NEXT_PUBLIC_AUTH_URL: "https://auth.yesp.space",
        NEXT_PUBLIC_CONSOLE_URL: "https://accounts.yesp.space",
      },
      error_file: "./logs/console-error.log",
      out_file: "./logs/console-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      listen_timeout: 15000,
      kill_timeout: 5000,
      restart_delay: 3000,
      max_restarts: 10,
      autorestart: true,
      stop_exit_codes: [0],
    },
  ],
};
