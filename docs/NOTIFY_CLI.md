# notify-cli 看板变更监控工具

通过 WebSocket 实时监控看板任务变更，变更发生时自动调用指定的 bash 脚本。

## 安装

```bash
cd backend
go build -o bin/notify-cli ./cmd/notify-cli
```

## 快速开始

```bash
# 连接到看板 WebSocket，监听所有 create 事件
./notify-cli \
    -ws ws://localhost:8080/ws \
    -token your-token \
    -rule "create:echo 'New task: $1'"

# 监控特定看板
./notify-cli \
    -ws ws://localhost:8080/ws \
    -token your-token \
    -rule "create:board-id-1,board-id-2:/scripts/on-create.sh"

# 仅打印，不执行（测试用）
./notify-cli -ws ws://localhost:8080/ws -token xxx -rule "update:echo test" -dry-run
```

## 命令行参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `-ws <url>` | 是 | WebSocket 地址 |
| `-token <token>` | 是 | 认证 Token |
| `-rule <规则>` | 是 | 事件规则（可多次指定） |
| `-dry-run` | 否 | 仅打印，不执行脚本 |

## 规则格式

```
eventType[:board1,board2,...]:command
```

| 部分 | 说明 |
|------|------|
| `eventType` | 事件类型（见下方） |
| `board1,board2` | 可选，限定哪些看板，多个用逗号分隔 |
| `command` | 要执行的命令 |

### 事件类型

| 事件 | 说明 |
|------|------|
| `create` | 新任务创建 |
| `update` | 任务更新（标题、描述等） |
| `update_status` | 任务状态变更（移动列） |
| `delete` | 任务删除 |
| `add_comment` | 新增评论 |

### 命令参数

执行命令时，会传递三个位置参数：

| 位置 | 内容 | 示例 |
|------|------|------|
| `$0` | 事件类型 | `create` |
| `$1` | 任务 ID | `abc123` |
| `$2` | 任务状态 | `in_progress` |

命令中也支持模板变量：

| 变量 | 说明 |
|------|------|
| `{{.BoardID}}` | 看板 ID |
| `{{.TaskID}}` | 任务 ID |
| `{{.Action}}` | 事件类型 |
| `{{.Status}}` | 任务状态 |
| `{{.Type}}` | 消息类型 |

## 示例脚本

### 示例 1：基础日志

```bash
#!/bin/bash
# on-task.sh - 记录任务变更到日志

EVENT=$0
TASK_ID=$1
STATUS=$2

LOG_FILE="/var/log/kanban-tasks.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

echo "[$TIMESTAMP] $EVENT: task=$TASK_ID status=$STATUS" >> $LOG_FILE
```

```bash
./notify-cli -ws ws://localhost:8080/ws -token xxx \
    -rule "create:$HOME/scripts/on-task.sh"
```

### 示例 2：发送桌面通知

```bash
#!/bin/bash
# notify-apple.sh - macOS 桌面通知

EVENT=$0
TASK_ID=$1
STATUS=$2

case "$EVENT" in
    create)
        osascript -e "display notification \"新任务创建: $TASK_ID\" with title \"看板通知\""
        ;;
    update)
        osascript -e "display notification \"任务更新: $TASK_ID\" with title \"看板通知\""
        ;;
    update_status)
        osascript -e "display notification \"任务状态变更为: $STATUS\" with title \"看板通知\""
        ;;
    add_comment)
        osascript -e "display notification \"新评论 on: $TASK_ID\" with title \"看板通知\""
        ;;
esac
```

```bash
./notify-cli -ws ws://localhost:8080/ws -token xxx \
    -rule "create:$HOME/scripts/notify-apple.sh" \
    -rule "update:$HOME/scripts/notify-apple.sh" \
    -rule "update_status:$HOME/scripts/notify-apple.sh" \
    -rule "add_comment:$HOME/scripts/notify-apple.sh"
```

### 示例 3：Slack Webhook

```bash
#!/bin/bash
# webhook.sh - 发送 Slack 通知

EVENT=$0
TASK_ID=$1
STATUS=$2
WEBHOOK_URL="https://hooks.slack.com/services/xxx/yyy/zzz"

case "$EVENT" in
    create)
        EMOJI=":tada:"
        TEXT="新任务创建"
        ;;
    update_status)
        EMOJI=":arrow_right:"
        TEXT="任务状态变更"
        ;;
    add_comment)
        EMOJI=":speech_balloon:"
        TEXT="新评论"
        ;;
    *)
        EMOJI=":bell:"
        TEXT="任务变更"
        ;;
esac

PAYLOAD="{\"text\": \"$EMOJI $TEXT\\n任务ID: $TASK_ID\\n状态: $STATUS\"}"
curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$WEBHOOK_URL"
```

### 示例 4：模板变量用法

不使用独立脚本，直接用内联命令和模板：

```bash
# 创建任务时打印信息
./notify-cli -ws ws://localhost:8080/ws -token xxx \
    -rule "create:echo 'New task {{.TaskID}} on board {{.BoardID}}'"

# 状态变更时打印
./notify-cli -ws ws://localhost:8080/ws -token xxx \
    -rule "update_status:echo 'Task {{.TaskID}} moved to {{.Status}}'"
```

### 示例 5：多看板分别处理

```bash
# 看板 A 和看板 B 的创建事件走不同脚本
./notify-cli -ws ws://localhost:8080/ws -token xxx \
    -rule "create:board-a-id,board-b-id:/scripts/important-create.sh" \
    -rule "create:other-board:/scripts/normal-create.sh"
```

### 示例 6：触发 CI/CD

```bash
#!/bin/bash
# trigger-deploy.sh - 触发部署

EVENT=$0
TASK_ID=$1
STATUS=$2

# 当任务标题包含 deploy- 前缀时触发部署
# 需要先获取任务详情确定标题

if [[ "$STATUS" == *"deploy-"* ]]; then || [ "$EVENT" == "update_status" ]; then
    DEPLOY_TARGET=$(echo "$STATUS" | sed 's/deploy-//')
    echo "Triggering deployment: $DEPLOY_TARGET"
    curl -X POST "https://ci.example.com/deploy" \
        -d "target=$DEPLOY_TARGET&task=$TASK_ID"
fi
```

## 完整使用示例

### 1. 启动看板服务

确保看板后端运行在 `localhost:8080`，且 WebSocket 可用。

### 2. 获取 Token

从看板设置或登录获取认证 Token。

### 3. 创建脚本目录

```bash
mkdir -p $HOME/kanban-scripts
```

### 4. 创建通知脚本

```bash
cat > $HOME/kanban-scripts/notify.sh << 'EOF'
#!/bin/bash
EVENT=$0
TASK_ID=$1
STATUS=$2

osascript -e "display notification \"$EVENT: $TASK_ID\" with title \"看板变更\""
echo "[$(date)] $EVENT: $TASK_ID ($STATUS)"
EOF
chmod +x $HOME/kanban-scripts/notify.sh
```

### 5. 运行监控

```bash
cd /path/to/backend

./notify-cli \
    -ws ws://localhost:8080/ws \
    -token "your-token-here" \
    -rule "create:$HOME/kanban-scripts/notify.sh" \
    -rule "update_status:$HOME/kanban-scripts/notify.sh" \
    -rule "add_comment:$HOME/kanban-scripts/notify.sh"
```

### 6. 测试模式

```bash
# 不实际执行，仅打印将要执行的命令
./notify-cli -ws ws://localhost:8080/ws -token xxx \
    -rule "create:echo test" -dry-run
```

## 故障排除

### 连接失败

```bash
# 检查 WebSocket 是否可用
curl -i -N \
    -H "Connection: Upgrade" \
    -H "Upgrade: websocket" \
    http://localhost:8080/ws
```

### Token 无效

确保 Token 有效且未过期，可从看板 UI 设置页面重新获取。

### 规则不匹配

使用 `-dry-run` 查看接收到的通知格式：

```bash
./notify-cli -ws ws://localhost:8080/ws -token xxx \
    -rule "create:echo 'got create'" \
    -dry-run
```

### 命令不执行

检查脚本权限：

```bash
chmod +x /path/to/your-script.sh
```
