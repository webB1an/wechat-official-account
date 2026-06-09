# CI/CD 部署说明

这个项目可以按 `pan-control` 的方式，用 GitHub Actions 直接发布到服务器。

- 发布目录：`/www/wwwroot/wechat-official-account`
- 运行方式：PM2
- 入口文件：`api/server.mjs`
- 静态编辑器目录：`huasheng_editor`
- 本地数据目录：`data`

## 触发规则

- 推送 `main` 分支时自动部署
- 也可以在 GitHub Actions 页面手动执行 `Run workflow`

## GitHub Secrets

进入 GitHub 仓库：

`Settings` -> `Secrets and variables` -> `Actions`

新增：

- `SSH_HOST`：服务器 IP 或域名
- `SSH_PORT`：SSH 端口，通常是 `22`
- `SSH_USER`：SSH 用户名
- `SSH_PRIVATE_KEY`：部署私钥内容
- `FEISHU_WEBHOOK`：可选，飞书通知 webhook

## 服务器准备

服务器需要安装：

- Node.js 22+
- npm
- pm2
- rsync
- tar
- curl

首次部署前建议先准备生产环境变量：

```bash
mkdir -p /www/wwwroot/wechat-official-account
cat > /www/wwwroot/wechat-official-account/.env <<'EOF'
DEEPSEEK_API_KEY=你的生产环境Key
PORT=8787
EOF
```

`.env` 和 `data/` 不会被 CI/CD 覆盖，SQLite 数据会保留在服务器本地。

## 本地推送到 GitHub

如果当前目录还不是 Git 仓库：

```bash
git init
git add .
git commit -m "Initial deploy setup"
git branch -M main
git remote add origin git@github.com:你的账号/你的仓库名.git
git push -u origin main
```

之后每次提交并推送到 `main`：

```bash
git add .
git commit -m "Update app"
git push
```

GitHub Actions 会自动发布到服务器。
