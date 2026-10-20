// PM2 definition for the ERP platform API on the oBizee API host
// (EC2 i-0f622c7494b9c6846), which also runs om-backend and star-api.
//
// Layout on the host, owned by the deploy job in .github/workflows/ci.yml:
//   /home/ubuntu/erp-api/releases/<sha>/index.mjs   one directory per deploy
//   /home/ubuntu/erp-api/current -> releases/<sha>  what pm2 runs
//   /home/ubuntu/erp-api/bin/node -> nvm Node 22    pinned here so om-backend
//                                                    keeps its own Node 20
//   /home/ubuntu/erp-api/.env                        server-only secrets, never in git
const ROOT = '/home/ubuntu/erp-api';

module.exports = {
  apps: [
    {
      name: 'erp-api',
      script: `${ROOT}/current/index.mjs`,
      cwd: ROOT,
      interpreter: `${ROOT}/bin/node`,
      node_args: `--env-file=${ROOT}/.env`,
      // The box has ~350 MB free and runs the live merchant API. A leak here
      // restarts this process instead of letting the kernel pick a victim.
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: '8790',
        ERP_RELEASE: process.env.ERP_RELEASE ?? 'unknown',
      },
    },
  ],
};
