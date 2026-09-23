import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const githubClientId = process.env.DSH_LAUNCHER_GITHUB_CLIENT_ID ?? env.DSH_LAUNCHER_GITHUB_CLIENT_ID ?? ''
  return {
    define: {
      // Client ID 不是密钥；发布构建通过仓库 Variable 注入后写入主进程包。
      'process.env.DSH_LAUNCHER_GITHUB_CLIENT_ID': JSON.stringify(githubClientId),
    },
    plugins: [
      react(),
      electron({
        main: {
          // 第二个入口是整合包打包 worker：导出时在 worker_threads 里跑 CRC/deflate，
          // 主进程只负责收进度事件。
          entry: ['electron/main.ts', 'electron/snapshot-pack-worker.ts'],
          vite: {
            define: {
              'process.env.DSH_LAUNCHER_GITHUB_CLIENT_ID': JSON.stringify(githubClientId),
            },
          },
        },
        preload: {
          input: 'electron/preload.ts',
        },
      }),
    ],
    server: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: false,
      // vendor/ 是 npm run fetch:node 解出来的随包 Node：Windows 会锁住刚落地的
      // node.exe，被 vite 的文件监视器碰上就是 EBUSY 直接崩进程。
      watch: {
        ignored: ['**/vendor/**'],
      },
    },
    build: {
      sourcemap: true,
    },
  }
})
