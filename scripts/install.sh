#!/bin/bash

set -e

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║           KL-Kanban 一键安装脚本                          ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

GITHUB_REPO="kl-kanban/kl-kanban"
INSTALL_DIR="$HOME/kl-kanban"

echo "=== 1. 检测平台 ==="
echo ""

get_platform() {
    local os=$(uname -s | tr '[:upper:]' '[:lower:]')
    local arch=$(uname -m)
    
    case $arch in
        x86_64) arch="amd64" ;;
        arm64|aarch64) arch="arm64" ;;
        *)
            echo -e "${RED}不支持的架构: $arch${NC}"
            exit 1
            ;;
    esac
    
    case $os in
        darwin) os="darwin" ;;
        linux) os="linux" ;;
        mingw*|cygwin*|msys*) os="windows" ;;
        *)
            echo -e "${RED}不支持的系统: $os${NC}"
            exit 1
            ;;
    esac
    
    echo "${os}-${arch}"
}

PLATFORM=$(get_platform)
SERVER_NAME="kanban-server-${PLATFORM}"
[ "$PLATFORM" = "windows-amd64" ] && SERVER_NAME="kanban-server-${PLATFORM}.exe"

echo -e "检测平台: ${GREEN}$PLATFORM${NC}"
echo ""

echo "=== 2. 检查依赖 ==="
echo ""

check_command() {
    local cmd=$1
    local name=$2
    local install_hint=$3
    
    if command -v $cmd &> /dev/null; then
        echo -e "${GREEN}✓${NC} $name"
        return 0
    else
        echo -e "${RED}✗${NC} $name"
        if [ -n "$install_hint" ]; then
            echo -e "    → $install_hint"
        fi
        return 1
    fi
}

check_command curl "curl" "安装: https://curl.se/"
check_command tar "tar" "系统自带，应已安装"
check_command unzip "unzip" "安装: apt install unzip (Linux) 或 brew install unzip (macOS)"

echo ""

echo "=== 3. 下载最新版本 ==="
echo ""

# Get latest release version
echo -e "${BLUE}>${NC} 获取最新版本..."
LATEST_VERSION=$(curl -s https://api.github.com/repos/$GITHUB_REPO/releases/latest | grep '"tag_name"' | sed 's/.*"v\?\([^"]*\)".*/\1/')

if [ -z "$LATEST_VERSION" ]; then
    echo -e "${YELLOW}无法获取最新版本，请检查网络连接${NC}"
    exit 1
fi

echo -e "最新版本: ${GREEN}$LATEST_VERSION${NC}"
echo ""

# Create install directory
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Download server
echo -e "${BLUE}>${NC} 下载 kanban-server..."
SERVER_URL="https://github.com/$GITHUB_REPO/releases/download/v${LATEST_VERSION#v}/${SERVER_NAME}"
curl -L -o "$SERVER_NAME" "$SERVER_URL"
chmod +x "$SERVER_NAME"

# Download web (frontend)
echo -e "${BLUE}>${NC} 下载前端文件..."
WEB_URL="https://github.com/$GITHUB_REPO/releases/download/v${LATEST_VERSION#v}/web.tar.gz"
curl -L -o "web.tar.gz" "$WEB_URL"
tar -xzf "web.tar.gz"
rm -f "web.tar.gz"

echo -e "${GREEN}✓${NC} 下载完成"
echo ""

echo "=== 4. 启动服务 ==="
echo ""

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}第一步：启动后端服务${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "运行："
echo -e "  ${GREEN}cd $INSTALL_DIR${NC}"
echo -e "  ${GREEN}./$SERVER_NAME${NC}"
echo ""
echo "看到以下信息表示启动成功："
echo -e "  ${YELLOW}Server starting on port 8080${NC}"
echo ""

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}第二步：访问应用${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "在浏览器中打开："
echo -e "  ${BLUE}http://localhost:8080${NC}"
echo ""

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}第三步：配置 AI 助手${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

echo "复制以下配置到你的 AI 助手的 MCP 配置文件中："
echo ""

echo -e "${YELLOW}【MCP 配置】${NC}"
echo -e "${BLUE}"
cat << 'MCP_EOF'
{
  "mcpServers": {
    "kanban": {
      "command": "npx",
      "args": ["-y", "kl-kanban-mcp"],
      "env": {
        "KANBAN_API_URL": "http://localhost:8080"
      }
    }
  }
}
MCP_EOF
echo -e "${NC}"
echo ""

echo -e "${YELLOW}【Skill 配置】${NC}"
echo "1. 创建目录："
echo -e "  ${GREEN}mkdir -p ~/.config/opencode/skills/do-kanban${NC}"
echo ""
echo "2. 创建文件 ${GREEN}~/.config/opencode/skills/do-kanban/SKILL.md${NC}，内容如下："
echo -e "${BLUE}"
cat << 'SKILL_EOF'
---
name: do-kanban
description: Use the kanban MCP tools to pick and execute a pending task end-to-end
---

# Kanban Do Skill

Use the kanban MCP tools to pick and execute a pending task end-to-end:

## Steps

1. **获取待办任务** — 调用 `mcp__kanban__list_tasks` 并传入 `status: "todo"` 获取所有待办任务。如果没有待办任务，告知用户并停止。获取时要注意用户是否给了 board或boardId,和 status

2. **选择任务（自动按优先级）** — 按以下规则自动选择任务，无需人工参与：
   - 首先按优先级排序：high > medium > low
   - 如果多个任务优先级相同，选择 ID 最小的任务（最早创建的任务）
   - 告知用户已自动选择的任务标题和优先级

3. **立即移动到进行中（抢锁）** — 调用 `mcp__kanban__update_task` 将选中任务的 `status` 改为 `in_progress`，确保其他用户无法同时选择该任务。告知用户任务已锁定并开始处理。

4. **读取任务详情** — 调用 `mcp__kanban__get_task` 获取完整任务描述，仔细阅读并理解需要完成的工作内容。

5. **执行任务** — 根据任务描述完整地执行工作：编写代码、修改文件、调试问题等。认真完成任务要求的所有内容。

6. **添加完成评论** — 调用 `mcp__kanban__add_comment` 为任务添加评论，总结：
   - 完成了哪些工作
   - 修改了哪些文件（如有）
   - 需要审核的要点

7. **移动到待审核** — 调用 `mcp__kanban__update_task` 将任务 `status` 改为 `review`，告知用户任务已完成并等待审核。

## 错误处理

- 若 kanban MCP 不可用：提示用户检查 MCP 服务器配置
- 若任务移动失败（可能已被其他用户抢占）：返回步骤1重新选择其他任务
- 若任务描述不清晰：调用 `mcp__kanban__add_comment` 添加评论说明任务描述不清晰，无法执行的具体原因，然后退出本次执行
- 若执行过程中遇到阻塞：在评论中说明进度和阻塞原因，再移动到 review
SKILL_EOF
echo -e "${NC}"
echo ""

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}第四步：开始使用${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "1. 在浏览器中打开 http://localhost:8080"
echo "2. 创建一些待办任务"
echo "3. 在 AI 助手中输入 ${GREEN}/do-kanban${NC}"
echo "   AI 会自动选取任务并完成"
echo ""

echo -e "${YELLOW}提示：后端服务需要保持运行${NC}"
echo -e "安装目录：${GREEN}$INSTALL_DIR${NC}"
echo ""
